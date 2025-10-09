// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/** GET /api/vouchers/remaining?draw_id=123 */
router.get("/remaining", requireAuth, async (req, res) => {
  const drawId = Number(req.query.draw_id);
  if (!Number.isFinite(drawId)) {
    return res.status(400).json({ error: "invalid_draw_id" });
  }

  try {
    const { rows } = await query(
      `select coalesce(sum(remaining),0)::int as remaining
         from vouchers
        where user_id = $1 and draw_id = $2`,
      [req.user.id, drawId]
    );
    res.json({ remaining: rows?.[0]?.remaining ?? 0 });
  } catch (e) {
    console.error("[vouchers/remaining] fail:", e);
    res.status(500).json({ error: "remaining_failed" });
  }
});

/**
 * POST /api/vouchers/consume
 * body: { draw_id, numbers:[...], reservationId? | reservation_id? }
 *
 * Fluxo:
 * - checa conflito com numbers ('sold','taken') e reservas ativas de OUTROS usuários
 * - debita vouchers (FIFO)
 * - confirma números como 'sold'
 * - se houver reservationId, marca como 'paid'
 * - cria um registro em `payments` com status **Approved** (id próprio)
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers)
    ? [...new Set(req.body.numbers.map((n) => Number(n)).filter(Number.isFinite))]
    : [];
  const reservationId = req.body?.reservationId || req.body?.reservation_id || null;

  if (!Number.isFinite(drawId) || nums.length === 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // 1) Conflitos em numbers: já vendidos/tomados
    const { rows: takenRows } = await query(
      `
      select n
        from numbers
       where draw_id = $1
         and n = any($2::smallint[])
         and status in ('sold','taken')
      `,
      [drawId, nums]
    );
    const conflictsFromNumbers = takenRows.map((r) => Number(r.n));

    // 2) Conflitos: reservas de OUTROS usuários ainda ativas
    const { rows: rconf } = await query(
      `
      with wanted(n) as ( select unnest($3::int2[]) )
      select distinct w.n
        from reservations r
        join wanted w on w.n = any(coalesce(r.numbers,'{}')::int2[])
       where r.draw_id = $1
         and r.user_id <> $2
         and (
              lower(coalesce(r.status,'')) = 'active'
           or lower(coalesce(r.status,'')) = 'reserved'
           or lower(coalesce(r.status,'')) = 'pending'
           or lower(coalesce(r.status,'')) like 'await%'
           or lower(coalesce(r.status,'')) like 'aguard%'
         )
      `,
      [drawId, req.user.id, nums]
    );
    const conflictsFromOthers = rconf.map((r) => Number(r.n));

    const conflicts = [...new Set([...conflictsFromNumbers, ...conflictsFromOthers])];
    if (conflicts.length) {
      await query("rollback");
      return res.status(409).json({ error: "unavailable", conflicts });
    }

    // 3) Saldo de vouchers (FIFO + lock)
    const { rows: vrows } = await query(
      `
      select id, remaining
        from vouchers
       where user_id = $1 and draw_id = $2 and remaining > 0
       order by created_at asc
       for update skip locked
      `,
      [req.user.id, drawId]
    );
    const totalRemaining = vrows.reduce((acc, r) => acc + Number(r.remaining || 0), 0);
    if (totalRemaining < nums.length) {
      await query("rollback");
      return res.status(409).json({ error: "not_enough_vouchers" });
    }

    // 4) Confirma números como 'sold'
    for (const n of nums) {
      const up = await query(
        `
        insert into numbers (draw_id, n, status)
        values ($1, $2::smallint, 'sold')
        on conflict (n, draw_id) do update
          set status = 'sold'
          where numbers.status in ('available','reserved')
        returning n
        `,
        [drawId, n]
      );
      if (!up.rowCount) {
        await query("rollback");
        return res.status(409).json({ error: "numbers_conflict", conflicts: [n] });
      }
    }

    // 5) Debita vouchers (FIFO)
    let toConsume = nums.length;
    for (const v of vrows) {
      if (toConsume <= 0) break;
      const take = Math.min(Number(v.remaining), toConsume);
      await query(
        `
        update vouchers
           set remaining   = remaining - $1,
               consumed_at = case when remaining - $1 = 0 then now() else consumed_at end,
               used        = case when remaining - $1 = 0 then true else used end
         where id = $2
        `,
        [take, v.id]
      );
      toConsume -= take;
    }

    // 6) Se houver reservationId, marca como 'paid' e mescla números
    let savedReservationId = null;
    if (reservationId) {
      const { rows: rrows } = await query(
        `
        update reservations
           set status  = 'paid',
               numbers = (
                 select array_agg(distinct x)::int2[]
                   from unnest(coalesce(reservations.numbers,'{}')::int2[] || $4::int2[]) as x
               )
         where id = $1 and user_id = $2 and draw_id = $3
         returning id
        `,
        [reservationId, req.user.id, drawId, nums]
      );
      savedReservationId = rrows?.[0]?.id || null;
    }

    // 7) Cria registro em payments com status "Approved" (id próprio)
    let paymentId = null;
    try {
      // Lê colunas existentes para montar INSERT compatível
      const { rows: cols } = await query(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'payments'`
      );
      const names = new Set(cols.map((c) => c.column_name));

      // Sempre forneça um ID (sua tabela não tem default)
      paymentId = `vch_${uuidv4().replace(/-/g, "")}`;

      const fields = ["id"];
      const values = ["$1"];
      const params = [paymentId];
      let p = 2;

      if (names.has("user_id")) {
        fields.push("user_id");
        values.push(`$${p}`);
        params.push(req.user.id);
        p++;
      }
      if (names.has("draw_id")) {
        fields.push("draw_id");
        values.push(`$${p}`);
        params.push(drawId);
        p++;
      }
      if (names.has("numbers")) {
        fields.push("numbers");
        values.push(`$${p}::int2[]`);
        params.push(nums);
        p++;
      }
      if (names.has("amount_cents")) {
        fields.push("amount_cents");
        values.push(`$${p}`);
        params.push(0);
        p++;
      }
      if (names.has("status")) {
        fields.push("status");
        values.push(`$${p}`);
        params.push("Approved"); // <- como solicitado
        p++;
      }
      if (names.has("method")) {
        fields.push("method");
        values.push(`$${p}`);
        params.push("voucher");
        p++;
      }
      if (names.has("paid_at")) {
        fields.push("paid_at");
        values.push("NOW()");
      }
      if (names.has("created_at")) {
        fields.push("created_at");
        values.push("NOW()");
      }
      if (names.has("reservation_id") && savedReservationId) {
        fields.push("reservation_id");
        values.push(`$${p}::uuid`);
        params.push(savedReservationId);
        p++;
      }

      // fallback mínimo caso o schema seja muito diferente
      if (fields.length < 3) {
        // id + status já temos; tenta pelo menos (id, status)
        await query(
          `insert into payments (id, status) values ($1, 'Approved')`,
          [paymentId]
        );
      } else {
        const sql = `insert into payments (${fields.join(",")}) values (${values.join(",")})`;
        await query(sql, params);
      }
    } catch (e) {
      console.warn("[vouchers/consume] payment insert skipped:", e?.message || e);
      paymentId = null; // não bloqueia a compra
    }

    await query("commit");

    return res.json({
      ok: true,
      consumed: nums.length,
      reservation_id: savedReservationId || null,
      payment_id: paymentId,
    });
  } catch (e) {
    await query("rollback").catch(() => {});
    console.error("[vouchers/consume] fail:", e);
    return res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
