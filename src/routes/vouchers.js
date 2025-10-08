// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** GET /api/vouchers/remaining?draw_id=123
 * Usa o campo `remaining` do schema atual (soma).
 */
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
 * body: { draw_id, numbers:[...] }
 * - valida se os números ainda estão livres
 * - garante saldo (somatório de remaining)
 * - grava `numbers` como 'sold'
 * - decrementa remaining dos vouchers do usuário
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers)
    ? [...new Set(req.body.numbers.map((n) => Number(n)).filter((n) => Number.isFinite(n)))]
    : [];

  if (!Number.isFinite(drawId) || nums.length === 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // 1) Checa conflitos de números já tomados
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
      return res.status(409).json({ error: "numbers_conflict", conflicts: taken.map((r) => r.n) });
    }

    // 2) Calcula saldo total de vouchers (remaining)
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

    // 3) Efetiva números como 'sold' (com proteção de concorrência)
    //    Se algum der conflito aqui, abortamos.
    for (const n of nums) {
      const ins = await query(
        `
        insert into numbers (draw_id, n, status)
        values ($1, $2, 'sold')
        on conflict (n, draw_id) do nothing
        returning n
        `,
        [drawId, n]
      );
      if (!ins.rowCount) {
        await query("rollback");
        return res.status(409).json({ error: "numbers_conflict", conflicts: [n] });
      }
    }

    // 4) Debita saldo dos vouchers (em ordem FIFO)
    let toConsume = nums.length;
    for (const v of vrows) {
      if (toConsume <= 0) break;
      const take = Math.min(v.remaining, toConsume);
      await query(
        `
        update vouchers
           set remaining = remaining - $1,
               consumed_at = case when remaining - $1 = 0 then now() else consumed_at end,
               used = case when remaining - $1 = 0 then true else used end
         where id = $2
        `,
        [take, v.id]
      );
      toConsume -= take;
    }

    await query("commit");
    res.json({ ok: true, consumed: nums.length });
  } catch (e) {
    await query("rollback");
    console.error("[vouchers/consume] fail:", e);
    // Render free às vezes derruba a conexão (XX000 / :db_termination).
    // O frontend já trata com um alerta genérico.
    res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
