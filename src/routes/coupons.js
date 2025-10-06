// backend/src/routes/coupons.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { trayCreateCoupon, trayDeleteCoupon } from "../services/tray.js";

const router = Router();
const VALID_DAYS = Number(process.env.TRAY_COUPON_VALID_DAYS || 180);

function codeForUser(userId) {
  const id = Number(userId || 0);
  const base = `NSU-${String(id).padStart(4, "0")}`;
  const salt = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const tail = salt[(id * 7) % salt.length] + salt[(id * 13) % salt.length];
  return `${base}-${tail}`;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- helpers de schema/tempo ----------

async function ensureUserColumns() {
  try {
    await query(`
      ALTER TABLE IF EXISTS users
        ADD COLUMN IF NOT EXISTS coupon_code text,
        ADD COLUMN IF NOT EXISTS tray_coupon_id text,
        ADD COLUMN IF NOT EXISTS coupon_value_cents int4 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS coupon_updated_at timestamptz,
        ADD COLUMN IF NOT EXISTS last_payment_sync_at timestamptz
    `);
  } catch {}
}

async function hasColumn(table, column, schema = "public") {
  const { rows } = await query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 AND column_name=$3
      LIMIT 1`,
    [schema, table, column]
  );
  return !!rows.length;
}

/**
 * Constrói a expressão de tempo usada para calcular o delta.
 * IMPORTANTE: não usar updated_at para evitar “ressuscitar” pagamentos antigos.
 */
async function buildTimeExpr() {
  const parts = [];
  if (await hasColumn("payments", "paid_at"))     parts.push("COALESCE(paid_at, to_timestamp(0))");
  if (await hasColumn("payments", "approved_at")) parts.push("COALESCE(approved_at, to_timestamp(0))");
  // fallback estável
  parts.push("COALESCE(created_at, to_timestamp(0))");
  const uniq = Array.from(new Set(parts));
  return uniq.length === 1 ? uniq[0] : `GREATEST(${uniq.join(", ")})`;
}

// ---------- rotas ----------

/**
 * POST /api/coupons/sync
 * Idempotente e à prova de corrida.
 */
router.post("/sync", requireAuth, async (req, res) => {
  const rid = Math.random().toString(36).slice(2, 8);
  const uid = req.user.id;
  try {
    await ensureUserColumns();

    // estado atual mínimo (fora da transação, só para saber tray/code)
    const curQ = await query(
      `SELECT id,
              COALESCE(coupon_value_cents,0)::int AS coupon_value_cents,
              coupon_code,
              tray_coupon_id,
              last_payment_sync_at
         FROM users
        WHERE id=$1
        LIMIT 1`,
      [uid]
    );
    if (!curQ.rows.length) return res.status(404).json({ error: "user_not_found" });
    let cur = curQ.rows[0];

    const code = (cur.coupon_code && String(cur.coupon_code).trim()) || codeForUser(uid);
    let trayId = cur.tray_coupon_id || null;

    const hadSyncBefore = !!cur.last_payment_sync_at; // ← usado para limitar o fallback
    const tExpr = await buildTimeExpr();

    // === Transação com lock para evitar duplicidade de incremento ===
    await query("BEGIN");

    // delta desde o último sync (sem updated_at)
    const sql = `
      WITH me AS (
        SELECT id, COALESCE(last_payment_sync_at, to_timestamp(0)) AS last_sync
          FROM users
         WHERE id = $1
         FOR UPDATE
      ),
      recent AS (
        SELECT COALESCE(SUM(p.amount_cents),0)::int AS delta,
               NULLIF(MAX(${tExpr}), to_timestamp(0)) AS max_t
          FROM payments p, me
         WHERE p.user_id = $1
           AND lower(p.status) IN ('approved','paid','pago')
           AND (${tExpr}) > me.last_sync
      ),
      upd AS (
        UPDATE users u
           SET coupon_value_cents   = u.coupon_value_cents + r.delta,
               last_payment_sync_at = COALESCE(r.max_t, u.last_payment_sync_at),
               coupon_code          = COALESCE(u.coupon_code, $2),
               coupon_updated_at    = NOW()
          FROM recent r
         WHERE u.id = $1
           AND r.delta > 0
        RETURNING u.coupon_value_cents AS final_cents,
                  r.delta AS delta_cents,
                  COALESCE(r.max_t, u.last_payment_sync_at) AS new_sync
      )
      SELECT
        COALESCE((SELECT delta_cents FROM upd), 0) AS delta_cents,
        (SELECT new_sync FROM upd) AS new_sync,
        (SELECT coupon_value_cents FROM users WHERE id=$1) AS final_cents;
    `;
    const { rows } = await query(sql, [uid, code]);
    await query("COMMIT");

    const delta = rows?.[0]?.delta_cents || 0;
    let finalCents = rows?.[0]?.final_cents ?? cur.coupon_value_cents;
    const newSync = rows?.[0]?.new_sync || cur.last_payment_sync_at;

    // 🔧 garante coupon_code mesmo com delta=0 (sem alterar lógica de valores)
    if (!cur.coupon_code) {
      try {
        await query(
          `UPDATE users
              SET coupon_code = $2,
                  coupon_updated_at = COALESCE(coupon_updated_at, NOW())
            WHERE id = $1
              AND coupon_code IS NULL`,
          [uid, code]
        );
        cur.coupon_code = code;
      } catch {}
    }

    console.log(
      `[coupons.sync#${rid}] user=${uid} lastSync=${cur.last_payment_sync_at || null} delta=${delta} newSync=${newSync} coupon_after=${finalCents}`
    );

    // --- Fallback controlado: só na PRIMEIRA sincronização (sem last_payment_sync_at)
    if (!hadSyncBefore) {
      const totalQ = await query(
        `SELECT COALESCE(SUM(amount_cents),0)::int AS total
           FROM payments
          WHERE user_id=$1 AND lower(status) IN ('approved','paid','pago')`,
        [uid]
      );
      const totalApproved = totalQ.rows?.[0]?.total || 0;
      if (totalApproved > finalCents) {
        await query(
          `UPDATE users
              SET coupon_value_cents = $2,
                  coupon_updated_at  = NOW(),
                  coupon_code        = COALESCE(coupon_code, $3),
                  last_payment_sync_at = COALESCE($4, last_payment_sync_at)
            WHERE id=$1`,
          [uid, totalApproved, code, newSync]
        );
        finalCents = totalApproved;
        console.log(`[coupons.sync#${rid}] first-sync correction up to total=${totalApproved}`);
      }
    }

    // Recria cupom na Tray apenas se mudou o valor ou não existe ainda
    const mustRecreateTray = !trayId || finalCents !== cur.coupon_value_cents;
    if (mustRecreateTray) {
      if (trayId) {
        try {
          console.log(`[coupons.sync#${rid}] deleting old Tray coupon id=${trayId}`);
          await trayDeleteCoupon(trayId);
        } catch (e) {
          console.warn(`[coupons.sync#${rid}] delete warn:`, e?.message || e);
        }
      }
      const startsAt = fmtDate(new Date());
      const endsAt = fmtDate(new Date(Date.now() + VALID_DAYS * 86400000));
      console.log(`[coupons.sync#${rid}] creating Tray coupon`, { code, value: finalCents / 100, startsAt, endsAt });
      try {
        const created = await trayCreateCoupon({
          code,
          value: finalCents / 100,
          startsAt,
          endsAt,
          description: `Crédito do cliente ${uid} - New Store`,
        });
        trayId = String(created.id);
        await query(
          `UPDATE users
              SET tray_coupon_id = $2,
                  coupon_updated_at = NOW()
            WHERE id = $1`,
          [uid, trayId]
        );
      } catch (e) {
        // ok: mantemos valor no banco mesmo que a Tray falhe
        console.warn(`[coupons.sync#${rid}] tray create warn:`, e?.message || e);
      }
    }

    return res.json({
      ok: true,
      code,
      value: finalCents / 100,
      cents: finalCents,
      id: trayId,
      synced: mustRecreateTray,
      last_payment_sync_at: newSync || null,
    });
  } catch (e) {
    try { await query("ROLLBACK"); } catch {}
    console.error(`[coupons.sync#${rid}] error:`, e?.message || e);
    // Valor já pode ter sido ajustado dentro da transação; mantém UI funcional.
    return res.status(200).json({ ok: false, error: "sync_failed" });
  }
});

/**
 * GET /api/coupons/mine
 */
router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensureUserColumns();
    const uid = req.user.id;
    const r = await query(
      `SELECT coupon_code,
              tray_coupon_id,
              COALESCE(coupon_value_cents,0)::int AS cents,
              coupon_updated_at,
              last_payment_sync_at
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [uid]
    );
    if (!r.rows.length) return res.status(404).json({ error: "user_not_found" });
    const row = r.rows[0];
    return res.json({
      ok: true,
      code: row.coupon_code || null,
      id: row.tray_coupon_id || null,
      value: (row.cents || 0) / 100,
      cents: row.cents || 0,
      coupon_updated_at: row.coupon_updated_at || null,
      last_payment_sync_at: row.last_payment_sync_at || null,
    });
  } catch (e) {
    return res.status(500).json({ error: "read_failed" });
  }
});

export default router;
