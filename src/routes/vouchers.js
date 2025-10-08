// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** GET /api/vouchers/remaining?draw_id=123
 * Retorna a soma de `remaining` dos vouchers do usuário p/ o sorteio.
 */
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
 * body: { draw_id, numbers:[...], reservation_id? }
 * - valida números livres
 * - efetiva números como "taken" (indisponíveis)
 * - debita vouchers do usuário (FIFO)
 * - marca a reserva como "paid" (se enviada)
 * - cria um registro em `payments` (method = 'voucher', amount_cents = 0)
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers)
    ? [...new Set(req.body.numbers.map(n => Number(n)).filter(Number.isFinite))]
    : [];
  const reservationId = req.body?.reservation_id || req.body?.reservationId || null;

  if (!Number.isFinite(drawId) || nums.length === 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // 1) Conflitos: já reservados/tomados?
    const { rows: taken } = await query(
      `
      select n
        from numbers
       where draw_id = $1
         and n = any($2::smallint[])
         and status <> 'available'
      `,
      [drawId, nums]
    );
    if (taken.length) {
      await query("rollback");
      return res.status(409).json({ error: "numbers_conflict", conflicts: taken.map(r => r.n) });
    }

    // 2) Saldo de vouchers (total remaining)
    const { rows: vrows } = await query(
      `
      select id, remaining
        from vouchers
       where user_id = $1
         and draw_id = $2
         and remaining > 0
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

    // 3) Efetiva números como "taken" (indisponíveis)
    //    Requer índice único em (draw_id, n).
    for (const n of nums) {
      const up = await query(
        `
        insert into numbers (draw_id, n, status)
        values ($1, $2::smallint, 'taken')
        on conflict (draw_id, n) do update
          set status = 'taken'
          where numbers.status = 'available'
        returning n
        `,
        [drawId, n]
      );
      if (!up.rowCount) {
        await query("rollback");
        return res.status(409).json({ error: "numbers_conflict", conflicts: [n] });
      }
    }

    // 4) Debita saldo dos vouchers (FIFO)
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

    // 5) Marca reserva como "paid" (se enviada)
    if (reservationId) {
      await query(
        `
        update reservations
           set status = 'paid',
               updated_at = now()
         where id = $1
           and user_id = $2
        `,
        [reservationId, req.user.id]
      );
    }

    // 6) Registra pagamento "voucher" (valor 0)
    let paymentId = null;
    try {
      const ins = await query(
        `
        insert into payments (user_id, draw_id, numbers, status, method, amount_cents, created_at, updated_at)
        values ($1, $2, $3::int[], 'paid', 'voucher', 0, now(), now())
        returning id
        `,
        [req.user.id, drawId, nums]
      );
      paymentId = ins?.rows?.[0]?.id ?? null;
    } catch (e) {
      // Se a tabela/coluna não existir, não quebra a transação principal.
      console.warn("[vouchers/consume] payments insert skipped:", e?.message || e);
    }

    await query("commit");
    res.json({
      ok: true,
      consumed: nums.length,
      reservation_id: reservationId || null,
      payment_id: paymentId,
    });
  } catch (e) {
    await query("rollback");
    console.error("[vouchers/consume] fail:", e);
    res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
