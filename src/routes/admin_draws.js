// backend/src/routes/admin_draws.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { runAutopayForDraw } from "../services/autopayRunner.js";

const router = Router();

async function requireAdmin(req, res, next) {
  try {
    const userId = req?.user?.id;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    const r = await query("select is_admin from users where id = $1", [userId]);
    if (!r.rows.length || !r.rows[0].is_admin) {
      return res.status(403).json({ error: "forbidden" });
    }
    return next();
  } catch (e) {
    console.error("[admin check] error", e);
    return res.status(500).json({ error: "admin_check_failed" });
  }
}

/* ------------------------------------------------------------------ *
 * ADMIN: criar sorteio + rodar Autopay
 * ------------------------------------------------------------------ */
router.post("/new", requireAuth, requireAdmin, async (req, res) => {
  try {
    const product_name = String(req.body?.product_name || "").slice(0, 255) || null;
    const product_link = String(req.body?.product_link || "").slice(0, 1024) || null;

    const ins = await query(
      `insert into draws (status, opened_at, product_name, product_link, autopay_ran_at)
       values ('open', now(), $1, $2, null)
       returning id, status, product_name, product_link`,
      [product_name, product_link]
    );
    if (!ins.rowCount) return res.status(500).json({ error: "create_failed" });

    const draw = ins.rows[0];
    console.log("[admin/draws/new] novo draw id =", draw.id);

    const result = await runAutopayForDraw(draw.id);
    if (!result?.ok) {
      return res.status(500).json({
        error: "autopay_run_failed",
        draw_id: draw.id,
        draw,
        autopay: result || null,
      });
    }
    return res.json({ ok: true, draw_id: draw.id, draw, autopay: result });
  } catch (e) {
    console.error("[admin/draws/new] error", e);
    return res.status(500).json({ error: "create_failed" });
  }
});

/* ------------------------------------------------------------------ *
 * Histórico (fechados)
 * ------------------------------------------------------------------ */
router.get("/history", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const r = await query(`
      select
        d.id,
        d.status,
        coalesce(d.opened_at, d.created_at) as opened_at,
        d.closed_at,
        d.realized_at,
        round(extract(epoch from (coalesce(d.closed_at, now()) - coalesce(d.opened_at, d.created_at))) / 86400.0)::int as days_open,
        coalesce(d.winner_name, '-') as winner_name
      from draws d
      where d.status = 'closed' or d.closed_at is not null
      order by d.id desc
    `);
    res.json({ history: r.rows || [] });
  } catch (e) {
    console.error("[admin/draws/history] error", e);
    res.status(500).json({ error: "list_failed" });
  }
});

/* ------------------------------------------------------------------ *
 * Participantes pagos (reservations)
 * ------------------------------------------------------------------ */
router.get("/:id/participants", requireAuth, requireAdmin, async (req, res) => {
  try {
    const drawId = Number(req.params.id);
    if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

    const sql = `
      select
        r.id as reservation_id,
        r.draw_id,
        r.user_id,
        num as number,
        r.status as status,
        r.created_at,
        coalesce(nullif(u.name,''), u.email, '-') as user_name,
        u.email as user_email
      from reservations r
      left join users u on u.id = r.user_id
      cross join lateral unnest(coalesce(r.numbers, '{}'::int[])) as num
      where r.draw_id = $1
        and (lower(coalesce(r.status,'')) = 'paid' or coalesce(r.paid,false) = true)
      order by user_name asc, number asc
    `;
    const r = await query(sql, [drawId]);
    res.json({ draw_id: drawId, participants: r.rows || [] });
  } catch (e) {
    console.error("[admin/draws/:id/participants] error", e);
    res.status(500).json({ error: "participants_failed" });
  }
});

/* Alias /players */
router.get("/:id/players", requireAuth, requireAdmin, async (req, res) => {
  try {
    const drawId = Number(req.params.id);
    if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

    const sql = `
      select
        r.id as reservation_id,
        r.draw_id,
        r.user_id,
        num as number,
        r.status as status,
        r.created_at,
        coalesce(nullif(u.name,''), u.email, '-') as user_name,
        u.email as user_email
      from reservations r
      left join users u on u.id = r.user_id
      cross join lateral unnest(coalesce(r.numbers, '{}'::int[])) as num
      where r.draw_id = $1
        and (lower(coalesce(r.status,'')) = 'paid' or coalesce(r.paid,false) = true)
      order by user_name asc, number asc
    `;
    const r = await query(sql, [drawId]);
    res.json({ draw_id: drawId, participants: r.rows || [] });
  } catch (e) {
    console.error("[admin/draws/:id/players] error", e);
    res.status(500).json({ error: "participants_failed" });
  }
});

/* ------------------------------------------------------------------ *
 * Reabrir + rodar Autopay
 * ------------------------------------------------------------------ */
router.post("/:id/open", requireAuth, requireAdmin, async (req, res) => {
  const drawId = Number(req.params.id);
  if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

  try {
    const up = await query(
      `update draws
          set status='open',
              opened_at = coalesce(opened_at, now()),
              closed_at = null,
              realized_at = null,
              autopay_ran_at = null
        where id = $1
        returning id, status`,
      [drawId]
    );
    if (!up.rowCount) return res.status(404).json({ error: "draw_not_found" });
  } catch (e) {
    console.error("[admin/draws/:id/open] error", e);
    return res.status(500).json({ error: "open_failed" });
  }

  const result = await runAutopayForDraw(drawId);
  if (!result?.ok) return res.status(500).json(result);
  return res.json(result);
});

/* ------------------------------------------------------------------ *
 * Rodar Autopay manualmente
 * ------------------------------------------------------------------ */
router.post("/:id/autopay-run", requireAuth, requireAdmin, async (req, res) => {
  const drawId = Number(req.params.id);
  if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

  const result = await runAutopayForDraw(drawId);
  if (!result?.ok) return res.status(500).json(result);
  return res.json(result);
});

export default router;
