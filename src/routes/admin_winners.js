// backend/src/routes/admin_winners.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();
const norm = (v, max = 2048) => String(v ?? "").trim().slice(0, max);

/**
 * GET /api/admin/winners
 * Lista sorteios realizados (realized_at IS NOT NULL)
 */
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `
      select
        d.id                                                as draw_id,
        coalesce(nullif(d.winner_name,''), u.name, u.email, '-') as winner_name,
        d.winner_number,
        d.realized_at,
        d.closed_at,
        d.product_name,
        d.product_link
      from public.draws d
      left join public.users u on u.id = d.winner_user_id
      where d.realized_at is not null
      order by d.realized_at desc, d.id desc
      `
    );

    const now = Date.now();
    const winners = (r.rows || []).map((row) => {
      const realized = row.realized_at ? new Date(row.realized_at) : null;
      const daysSince = realized ? Math.max(0, Math.floor((now - realized.getTime()) / 86400000)) : 0;
      const redeemed = !!row.closed_at;
      return {
        draw_id: row.draw_id,
        winner_name: row.winner_name || "-",
        winner_number: row.winner_number ?? null,
        realized_at: row.realized_at,
        closed_at: row.closed_at,
        product_name: row.product_name || "",
        product_link: row.product_link || "",
        redeemed,
        status: redeemed ? "RESGATADO" : "NÃO RESGATADO",
        days_since: daysSince,
      };
    });

    return res.json({ winners });
  } catch (e) {
    console.error("[admin/winners] error:", e);
    return res.status(500).json({ error: "list_failed" });
  }
});

/**
 * PATCH /api/admin/winners/:id
 * body: { product_name?, product_link? }
 */
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { product_name, product_link } = req.body || {};

    const { rows } = await query(
      `
      update public.draws
         set product_name = coalesce($2, product_name),
             product_link = coalesce($3, product_link)
       where id = $1
       returning id, product_name, product_link
      `,
      [
        id,
        product_name != null ? norm(product_name, 255) : null,
        product_link != null ? norm(product_link, 2048) : null,
      ]
    );

    if (!rows.length) return res.status(404).json({ error: "not_found" });

    return res.json({
      draw_id: rows[0].id,
      product_name: rows[0].product_name || "",
      product_link: rows[0].product_link || "",
    });
  } catch (e) {
    console.error("[admin/winners PATCH] error:", e);
    return res.status(500).json({ error: "update_failed" });
  }
});

export default router;
