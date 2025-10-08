// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** GET /api/vouchers/remaining?draw_id=123 */
router.get("/remaining", requireAuth, async (req, res) => {
  const drawId = Number(req.query.draw_id);
  if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

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
 * body: { draw_id, numbers:[...], reservationId? }
 * - valida conflitos (vendidos e reservados por OUTRO usuário)
 * - garante saldo em `vouchers`
 * - marca `numbers` como 'sold' (sem depender de UNIQUE/ON CONFLICT)
 * - debita vouchers (FIFO)
 * - marca a reserva como 'paid' (se veio reservationId)
 * - cria um payment “voucher” simples (apenas histórico)
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

    // (0) Reserva do próprio usuário (se informada)
    let ownedReserved = new Set();
    if (reservationId) {
      const { rows: rrows } = await query(
        `
        select id, user_id, draw_id, numbers, status,
               coalesce(reserved_until, now() + interval '1 second') as reserved_until
          from reservations
         where id = $1
         for update
        `,
        [reservationId]
      );
      const r = rrows?.[0];
      const active =
        r &&
        Number(r.user_id) === Number(req.user.id) &&
        Number(r.draw_id) === Number(drawId) &&
        !/^(paid|expired|cancel)/i.test(String(r.status || "")) &&
        new Date(r.reserved_until).getTime() > Date.now();

      if (!active) {
        await query("rollback");
        return res.status(409).json({ error: "reservation_not_active" });
      }
      const arr = Array.isArray(r.numbers) ? r.numbers.map(Number).filter(Number.isFinite) : [];
      ownedReserved = new Set(nums.filter(n => arr.includes(n)));
    }

    // (1a) Conflitos: vendidos
    const { rows: soldRows } = await query(
      `
      select n
        from numbers
       where draw_id = $1
         and n = any($2::int[])
         and status in ('sold','taken')
      `,
      [drawId, nums]
    );
    const soldConflicts = new Set(soldRows.map(r => Number(r.n)));

    // (1b) Conflitos: reservados por OUTRO usuário (ativos)
    const { rows: otherRes } = await query(
      `
      select numbers
        from reservations
       where draw_id = $1
         and user_id <> $2
         and status in ('active','reserved','pending','await')
         and (reserved_until is null or reserved_until > now())
         and numbers && $3::int[]
       for update
      `,
      [drawId, req.user.id, nums]
    );
    const reservedByOthers = new Set();
    for (const rr of otherRes || []) {
      const arr = Array.isArray(rr.numbers) ? rr.numbers.map(Number) : [];
      for (const n of arr) if (nums.includes(n)) reservedByOthers.add(n);
    }

    // (1c) Conflitos adicionais se NÃO houve reservationId (linhas 'reserved' genéricas)
    let additionalReserved = new Set();
    if (!reservationId) {
      const { rows } = await query(
        `
        select n
          from numbers
         where draw_id = $1
           and n = any($2::int[])
           and status = 'reserved'
        `,
        [drawId, nums]
      );
      additionalReserved = new Set(rows.map(r => Number(r.n)));
    }

    const conflicts = [...new Set([
      ...soldConflicts,
      ...reservedByOthers,
      ...additionalReserved
    ])].filter(n => !ownedReserved.has(n));

    if (conflicts.length) {
      await query("rollback");
      return res.status(409).json({ error: "numbers_conflict", conflicts });
    }

    // (2) Vouchers – trava e valida saldo
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

    // (3) Efetiva cada número como 'sold' SEM depender de UNIQUE/ON CONFLICT
    //     Lock de linha se existir; se não existir, cria
    for (const n of nums) {
      const { rows: cur } = await query(
        `select status from numbers where draw_id = $1 and n = $2::int for update`,
        [drawId, n]
      );
      if (!cur.length) {
        // não existe -> cria como sold
        await query(
          `insert into numbers (draw_id, n, status) values ($1, $2::int, 'sold')`,
          [drawId, n]
        );
        continue;
      }
      const st = String(cur[0].status || "").toLowerCase();
      if (st === "available" || st === "reserved") {
        await query(
          `update numbers set status = 'sold' where draw_id = $1 and n = $2::int`,
          [drawId, n]
        );
      } else {
        await query("rollback");
        return res.status(409).json({ error: "numbers_conflict", conflicts: [n] });
      }
    }

    // (4) Debita vouchers (FIFO)
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

    // (4b) Marca reserva como paga (se houver)
    if (reservationId) {
      await query(
        `update reservations set status = 'paid', paid_at = now() where id = $1`,
        [reservationId]
      );
    }

    // (4c) Cria registro simples em payments (histórico). NÃO falha a operação se der erro.
    try {
      const { rows: priceRow } = await query(
        `select coalesce(price_cents, amount_cents, price, 0)::int as price_cents
           from draws
          where id = $1`,
        [drawId]
      );
      const unitCents = Number(priceRow?.[0]?.price_cents || 0);
      const totalCents = unitCents * nums.length;

      await query(
        `
        insert into payments (user_id, draw_id, numbers, amount_cents)
        values ($1, $2, $3::int[], $4)
        `,
        [req.user.id, drawId, nums, totalCents]
      );
    } catch (e) {
      console.warn("[vouchers/consume] payments insert skipped:", e?.message || e);
    }

    await query("commit");
    res.json({ ok: true, consumed: nums.length });
  } catch (e) {
    await query("rollback");
    console.error("[vouchers/consume] fail:", e);
    res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
