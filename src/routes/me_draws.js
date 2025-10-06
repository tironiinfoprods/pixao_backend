import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/me/draws/:id/board
 * Retorna o tabuleiro 00..99 com:
 * - isMine: números do usuário logado (payments aprovados/pagos)
 * - state: available | reserved | taken
 * - isWinner: número sorteado
 * Também retorna product_name/product_link e o nome do vencedor (se houver).
 */
router.get("/:id/board", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const drawId = Number(req.params.id);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({ error: "bad_draw_id" });
    }

    // dados do sorteio + produto + nome do vencedor
    const d = await query(
      `SELECT d.id,
              d.status,
              d.realized_at,
              d.winner_user_id,
              d.winner_number,
              d.product_name,
              d.product_link,
              u.name AS winner_name
         FROM public.draws d
    LEFT JOIN public.users u
           ON u.id = d.winner_user_id
        WHERE d.id = $1
        LIMIT 1`,
      [drawId]
    );
    if (!d.rows.length) return res.status(404).json({ error: "draw_not_found" });
    const draw = d.rows[0];

    // números comprados por QUALQUER pessoa (indisponíveis)
    const takenR = await query(
      `SELECT unnest(p.numbers)::int AS n
         FROM public.payments p
        WHERE p.draw_id = $1
          AND LOWER(p.status) IN ('approved','paid','pago')`,
      [drawId]
    );

    // reservas ativas/pending/paid (marcamos como "reserved")
    const resvR = await query(
      `SELECT unnest(r.numbers)::int AS n
         FROM public.reservations r
        WHERE r.draw_id = $1
          AND LOWER(r.status) IN ('active','pending','paid')`,
      [drawId]
    );

    // números do usuário logado
    const mineR = await query(
      `SELECT unnest(p.numbers)::int AS n
         FROM public.payments p
        WHERE p.draw_id = $1
          AND p.user_id = $2
          AND LOWER(p.status) IN ('approved','paid','pago')`,
      [drawId, userId]
    );

    const setTaken = new Set((takenR.rows || []).map(r => Number(r.n)));
    const setResv  = new Set((resvR.rows  || []).map(r => Number(r.n)));
    const setMine  = new Set((mineR.rows  || []).map(r => Number(r.n)));
    const winner   = (draw.winner_number ?? null);

    // monta a grade 00..99
    const board = Array.from({ length: 100 }, (_, n) => {
      const isMine   = setMine.has(n);
      const isTaken  = setTaken.has(n);
      const isRes    = setResv.has(n);
      const state =
        isMine ? "taken" :
        isTaken ? "taken" :
        isRes ? "reserved" : "available";
      return {
        n,
        label: String(n).padStart(2, "0"),
        state,                  // available | reserved | taken
        isMine,
        isWinner: winner === n  // usado no UI para estilizar e mostrar o nome
      };
    });

    return res.json({
      draw: {
        id: draw.id,
        status: draw.status,
        realized_at: draw.realized_at,
        winner_number: winner,
        product_name: draw.product_name || null,
        product_link: draw.product_link || null,
        winner_name: draw.winner_name || null,
      },
      my_numbers: Array.from(setMine).sort((a,b)=>a-b),
      board
    });
  } catch (e) {
    console.error("[me/draws/:id/board] error:", e);
    return res.status(500).json({ error: "board_failed" });
  }
});

export default router;
