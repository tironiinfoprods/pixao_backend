// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

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

/** POST /api/vouchers/consume
 * body: { draw_id, numbers:[...], reservationId? | reservation_id? }
 * Regras:
 * - conflito se: já estiver 'sold'/'taken' OU 'reserved' por OUTRO usuário
 * - permite virar 'sold' se estiver 'available' ou 'reserved' PELO MESMO usuário (e opcionalmente pela mesma reserva)
 * - debita vouchers do usuário (FIFO)
 * - marca a reservation enviada como 'paid'
 * - tenta registrar pagamento (best-effort)
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers)
    ? [...new Set(req.body.numbers.map(n => Number(n)).filter(Number.isFinite))]
    : [];
  const reservationId = req.body?.reservationId || req.body?.reservation_id || null;

  if (!Number.isFinite(drawId) || nums.length === 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // 1) Conflitos:
    //    - vendidos/tomados
    //    - reservados por OUTRO usuário (permitimos reservado pelo próprio usuário)
    const { rows: conflicts } = await query(
      `
      with input(n) as (select unnest($2::smallint[]))
      select i.n
        from input i
       where exists (
              select 1
                from numbers num
               where num.draw_id = $1
                 and num.n = i.n
                 and num.status in ('sold','taken')
            )
          or exists (
              select 1
                from numbers num
               where num.draw_id = $1
                 and num.n = i.n
                 and num.status = 'reserved'
                 and not exists (
                       select 1
                         from reservations r
                        where r.draw_id = $1
                          and r.user_id = $3
                          and r.status in ('active','pending','reserved')
                          and i.n = any(r.numbers)
                     )
            )
      `,
      [drawId, nums, req.user.id]
    );

    if (conflicts.length) {
      await query("rollback");
      return res
        .status(409)
        .json({ error: "numbers_conflict", conflicts: conflicts.map(r => r.n) });
    }

    // 2) Saldo de vouchers (lock FIFO)
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

    // 3) Efetiva números como 'sold'
    //    - insere se não existir
    //    - atualiza se 'available'
    //    - atualiza se 'reserved' pelo MESMO usuário (e opcionalmente pela mesma reserva)
    for (const n of nums) {
      const up = await query(
        `
        insert into numbers (draw_id, n, status)
        values ($1, $2::smallint, 'sold')
        on conflict (draw_id, n) do update
          set status = 'sold'
          where numbers.status = 'available'
             or (
                  numbers.status = 'reserved'
              and exists (
                    select 1
                      from reservations r
                     where r.draw_id = $1
                       and r.user_id = $3
                       and ($4::uuid is null or r.id = $4::uuid)
                       and r.status in ('active','pending','reserved')
                       and numbers.n = any(r.numbers)
                  )
             )
        returning n
        `,
        [drawId, n, req.user.id, reservationId]
      );

      if (!up.rowCount) {
        await query("rollback");
        return res.status(409).json({ error: "numbers_conflict", conflicts: [n] });
      }
    }

    // 4) Debita vouchers (FIFO)
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

    // 5) Se veio reservationId, marca como 'paid' e mescla números
    let savedReservationId = null;
    if (reservationId) {
      const { rows: rrows } = await query(
        `
        update reservations
           set status  = 'paid',
               numbers = (
                 select array_agg(distinct x)::int2[]
                   from unnest(coalesce(reservations.numbers,'{}')::int2[] || $4::int2[]) as x
               ),
               updated_at = now()
         where id = $1 and user_id = $2 and draw_id = $3
         returning id
        `,
        [reservationId, req.user.id, drawId, nums]
      );
      savedReservationId = rrows?.[0]?.id || null;
    }

    await query("commit");

    // 6) Pagamento best-effort (fora da transação)
    let paymentId = null;
    try {
      const { rows: cols } = await query(
        `select column_name
           from information_schema.columns
          where table_schema='public' and table_name='payments'`
      );
      const have = new Set(cols.map(c => c.column_name));
      const fields = [], values = [], params = [];
      let p = 1;

      if (have.has("user_id")) { fields.push("user_id"); params.push(req.user.id); values.push(`$${p++}`); }
      if (have.has("draw_id")) { fields.push("draw_id"); params.push(drawId); values.push(`$${p++}`); }
      if (have.has("numbers")) { fields.push("numbers"); params.push(nums); values.push(`$${p++}::int2[]`); }
      if (have.has("status"))  { fields.push("status");  params.push("paid"); values.push(`$${p++}`); }
      if (have.has("amount_cents")) { fields.push("amount_cents"); params.push(0); values.push(`$${p++}`); }
      if (have.has("method")) { fields.push("method"); params.push("voucher"); values.push(`$${p++}`); }
      if (have.has("reservation_id") && savedReservationId) {
        fields.push("reservation_id"); params.push(savedReservationId); values.push(`$${p++}::uuid`);
      }

      if (fields.length >= 3) {
        const sql = `insert into payments (${fields.join(",")}) values (${values.join(",")}) returning id`;
        const ins = await query(sql, params);
        paymentId = ins?.rows?.[0]?.id || null;
      }
    } catch (e) {
      console.warn("[vouchers/consume] payment insert skipped:", e?.message || e);
    }

    return res.json({
      ok: true,
      consumed: nums.length,
      reservation_id: savedReservationId || null,
      payment_id: paymentId || null,
    });
  } catch (e) {
    await query("rollback").catch(() => {});
    console.error("[vouchers/consume] fail:", e);
    return res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
