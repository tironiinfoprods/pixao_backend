// src/routes/admin_clients.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/admin/clients/active
 * Lista SOMENTE clientes com saldo manual > 0.
 * O saldo considerado é EXCLUSIVAMENTE o campo `coupon_value_cents`.
 * (Se a coluna não existir, faz fallback para `coupon_cents`.)
 */
router.get("/active", requireAuth, requireAdmin, async (_req, res) => {
  async function run(col /* 'coupon_value_cents' | 'coupon_cents' */) {
    const r = await query(
      `
      WITH pays AS (
        SELECT
          p.user_id,
          COUNT(*) FILTER (WHERE lower(trim(coalesce(p.status,''))) = 'approved') AS compras,
          MAX(COALESCE(p.paid_at, p.created_at)) FILTER (WHERE lower(trim(coalesce(p.status,''))) = 'approved') AS last_buy
        FROM public.payments p
        GROUP BY p.user_id
      ),
      wins AS (
        SELECT winner_user_id AS user_id, COUNT(*) AS wins
        FROM public.draws
        WHERE winner_user_id IS NOT NULL
        GROUP BY winner_user_id
      )
      SELECT
        u.id,
        COALESCE(NULLIF(u.name,''), u.email, '-') AS name,
        u.email,
        u.created_at,
        COALESCE(pa.compras, 0)                    AS compras,
        pa.last_buy,
        COALESCE(w.wins, 0)                        AS wins,
        NULLIF(TRIM(u.coupon_code), '')            AS coupon_code,
        COALESCE(u.${col}, 0)::bigint              AS coupon_value_cents,

        -- validade: se não houver compra, conta 6 meses a partir de agora
        (COALESCE(pa.last_buy, NOW()) + INTERVAL '6 months')::date AS expires_at,
        ((COALESCE(pa.last_buy, NOW()) + INTERVAL '6 months')::date - NOW()::date) AS days_to_expire
      FROM public.users u
      LEFT JOIN pays pa ON pa.user_id = u.id
      LEFT JOIN wins w  ON w.user_id = u.id
      WHERE COALESCE(u.${col}, 0) > 0  -- SOMENTE quem tem saldo manual > 0
      ORDER BY expires_at ASC, coupon_value_cents DESC
      `
    );

    const items = (r.rows || []).map((row) => {
      const cents = Number(row.coupon_value_cents || 0);
      return {
        user_id: row.id,
        name: row.name,
        email: row.email,
        created_at: row.created_at,

        purchases_count: Number(row.compras || 0),
        last_buy: row.last_buy,
        wins: Number(row.wins || 0),

        coupon_code: row.coupon_code || null,
        coupon_value_cents: cents,
        coupon_value_brl: +(cents / 100).toFixed(2),

        // Compat com o front atual (coluna "VALOR TOTAL INVESTIDO"):
        total_brl: +(cents / 100).toFixed(2),

        expires_at: row.expires_at,
        days_to_expire: Math.max(0, Number(row.days_to_expire) || 0),
      };
    });

    // garantia extra: não devolver ninguém com 0
    return items.filter((i) => (i.coupon_value_cents || 0) > 0);
  }

  try {
    // tenta com coupon_value_cents; se a coluna não existir, usa coupon_cents
    try {
      const items = await run("coupon_value_cents");
      return res.json({ clients: items });
    } catch (e1) {
      if (e1?.code !== "42703") throw e1;
      const items = await run("coupon_cents");
      return res.json({ clients: items });
    }
  } catch (e) {
    console.error("[admin/clients/active] error:", e?.code, e?.message);
    return res.status(500).json({ error: "list_failed" });
  }
});

/**
 * GET /api/admin/clients/:userId/coupon
 * Lê o saldo manual do usuário (preferindo `coupon_value_cents`).
 * Sempre responde 200 com { user_id, code, cents }.
 */
router.get("/:userId/coupon", requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: "invalid_user_id" });
  }

  try {
    // tenta coupon_value_cents
    try {
      const r = await query(
        `
        SELECT
          NULLIF(TRIM(u.coupon_code), '')           AS code,
          COALESCE(u.coupon_value_cents, 0)::bigint AS cents
        FROM public.users u
        WHERE u.id = $1
        LIMIT 1
        `,
        [userId]
      );
      if (!r.rowCount) return res.json({ user_id: userId, code: null, cents: 0 });
      const { code, cents } = r.rows[0];
      return res.json({ user_id: userId, code: code || null, cents: Number(cents || 0) });
    } catch (e1) {
      if (e1?.code !== "42703") throw e1;
      // fallback: coupon_cents
      const r2 = await query(
        `
        SELECT
          NULLIF(TRIM(u.coupon_code), '')     AS code,
          COALESCE(u.coupon_cents, 0)::bigint AS cents
        FROM public.users u
        WHERE u.id = $1
        LIMIT 1
        `,
        [userId]
      );
      if (!r2.rowCount) return res.json({ user_id: userId, code: null, cents: 0 });
      const { code, cents } = r2.rows[0];
      return res.json({ user_id: userId, code: code || null, cents: Number(cents || 0) });
    }
  } catch (e) {
    console.error("[admin/clients/:userId/coupon] error:", e?.code, e?.message);
    return res.json({ user_id: userId, code: null, cents: 0 });
  }
});

export default router;
