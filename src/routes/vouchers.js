// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** GET /api/vouchers/remaining?draw_id=123 */
router.get("/remaining", requireAuth, async (req, res) => {
  const drawId = Number(req.query.draw_id);
  if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

  const { rows } = await query(
    `select coalesce(sum(case when used=false then 1 else 0 end),0)::int as remaining
       from vouchers
      where user_id = $1 and draw_id = $2`,
    [req.user.id, drawId]
  );
  res.json({ remaining: rows?.[0]?.remaining ?? 0 });
});

/** POST /api/vouchers/consume  { draw_id, numbers:[...] }
 * Consome N vouchers e guarda os números escolhidos.
 * Aqui você pode também chamar sua lógica de reserva definitiva (numbers table).
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers) ? req.body.numbers.map(Number) : [];
  if (!Number.isFinite(drawId) || !nums.length) return res.status(400).json({ error: "invalid_payload" });

  // transação
  try {
    await query("begin");

    // bloqueia vouchers disponíveis do usuário
    const { rows: free } = await query(
      `select id from vouchers
        where user_id=$1 and draw_id=$2 and used=false
        order by id
        for update skip locked
        limit $3`,
      [req.user.id, drawId, nums.length]
    );

    if (free.length < nums.length) {
      await query("rollback");
      return res.status(409).json({ error: "not_enough_vouchers" });
    }

    // (opcional) valide se números já não estão tomados na tabela numbers
    // ...

    // marca como usados + grava o número
    for (let i = 0; i < nums.length; i++) {
      const vId = free[i].id;
      const n = nums[i];
      await query(
        `update vouchers set used=true, used_at=now(), number=$1 where id=$2`,
        [n, vId]
      );

      // aqui você pode efetivar na sua tabela numbers/reservations:
      // insert into numbers (draw_id, n, status, user_id, created_at) values ($1,$2,'sold',$3,now())
      // ... ou chamar o que você já usa hoje
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
