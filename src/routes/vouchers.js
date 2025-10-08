// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/vouchers/remaining?draw_id=123
 * Soma dos vouchers não usados do usuário nesse draw.
 * Observa teu schema: usamos (used=false) e "remaining" (smallint).
 */
router.get("/remaining", requireAuth, async (req, res) => {
  const drawId = Number(req.query.draw_id);
  if (!Number.isFinite(drawId)) {
    return res.status(400).json({ error: "invalid_draw_id" });
  }

  const { rows } = await query(
    `select coalesce(sum(case when used = false then remaining else 0 end),0)::int as remaining
       from vouchers
      where user_id = $1 and draw_id = $2`,
    [req.user.id, drawId]
  );
  return res.json({ remaining: rows?.[0]?.remaining ?? 0 });
});

/**
 * POST /api/vouchers/consume
 * body: { draw_id: number, numbers: number[] }
 *
 * - Pega N vouchers livres (used=false) do usuário para o draw
 * - Marca used=true, remaining=0, consumed_at=now()
 * - Efetiva na tabela numbers (PK (n, draw_id))
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers) ? req.body.numbers.map(Number) : [];
  if (!Number.isFinite(drawId) || !nums.length) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // (1) bloqueia vouchers disponíveis
    const free = await query(
      `select id
         from vouchers
        where user_id=$1 and draw_id=$2 and used=false
        order by created_at asc
        for update skip locked
        limit $3`,
      [req.user.id, drawId, nums.length]
    );

    if (free.rows.length < nums.length) {
      await query("rollback");
      return res.status(409).json({ error: "not_enough_vouchers" });
    }

    // (2) valida e efetiva números na tabela numbers
    //     Se já existir (PK), vai falhar; tratamos para devolver erro 409.
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];

      // tenta inserir como vendido
      try {
        await query(
          `insert into numbers (draw_id, n, status)
           values ($1, $2, 'sold')`,
          [drawId, n]
        );
      } catch (e) {
        // se falhar por PK, o número já está tomado
        await query("rollback");
        return res.status(409).json({ error: "number_unavailable", n });
      }
    }

    // (3) marca os vouchers como consumidos
    for (let i = 0; i < nums.length; i++) {
      const vId = free.rows[i].id;
      await query(
        `update vouchers
            set used=true, remaining=0, consumed_at=now()
          where id=$1`,
        [vId]
      );
    }

    await query("commit");
    return res.json({ ok: true, consumed: nums.length });
  } catch (e) {
    await query("rollback");
    console.error("[vouchers/consume] fail:", e);
    return res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
