// backend/src/routes/admin.infoproducts.js
import express from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// Se você já tiver um middleware de admin, use-o aqui.
function requireAdmin(req, res, next) {
  // ajuste conforme seu payload de user
  if (req.user?.is_admin || req.user?.role === "admin") return next();
  return res.status(403).json({ error: "forbidden" });
}

/**
 * Normaliza entrada: aceita category_id ou category_slug
 * e converte price/prize para *_cents (inteiro).
 */
async function normalizeBody(body) {
  const out = {};

  out.sku = String(body.sku ?? "").trim();
  out.title = String(body.title ?? "").trim();
  out.subtitle = String(body.subtitle ?? "").trim();
  out.description = String(body.description ?? "").trim();
  out.cover_url = body.cover_url ?? null;
  out.file_url = body.file_url ?? null;
  out.file_sha256 = body.file_sha256 ?? null;

  // "1,00" / "1.00" -> 100
  const toCents = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    if (Number.isNaN(n)) return null;
    return Math.round(n * 100);
  };

  const price_cents = body.price_cents ?? toCents(body.price);
  const prize_cents = body.default_prize_cents ?? toCents(body.prize);
  const total_numbers = body.default_total_numbers ?? body.total_numbers ?? null;

  out.price_cents = price_cents ?? null;
  out.default_prize_cents = prize_cents ?? null;
  out.default_total_numbers = total_numbers ? Number(total_numbers) : null;

  // flags
  out.active = body.active === false ? false : true;

  // categoria: aceita id direto, ou busca por slug
  let category_id = body.category_id ?? null;
  const category_slug = (body.category_slug ?? "").trim();
  if (!category_id && category_slug) {
    const { rows } = await query(
      `SELECT id FROM categories WHERE LOWER(slug)=LOWER($1) LIMIT 1`,
      [category_slug]
    );
    category_id = rows?.[0]?.id ?? null;
  }
  out.category_id = category_id ?? null;
  out.category_slug = category_slug || body.category_slug || null;

  return out;
}

/* =========================================
 * LIST (com paginação e busca)
 * GET /api/admin/infoproducts?search=&page=1&limit=20
 * ========================================= */
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20));
    const offset = (page - 1) * limit;
    const search = String(req.query.search ?? "").trim().toLowerCase();

    const params = [];
    let where = "WHERE 1=1";
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (
        LOWER(p.sku) LIKE $${params.length} OR
        LOWER(p.title) LIKE $${params.length} OR
        LOWER(COALESCE(p.subtitle,'')) LIKE $${params.length} OR
        LOWER(COALESCE(p.category_slug,'')) LIKE $${params.length}
      )`;
    }

    params.push(limit, offset);
    const { rows } = await query(
      `
      SELECT
        p.*,
        c.name AS category_name,
        c.slug AS category_slug_resolved
      FROM infoproducts p
      LEFT JOIN categories c ON c.id = p.category_id
      ${where}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    const { rows: tot } = await query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM infoproducts p
      ${where.replace("p.*", "1")}
      `,
      search ? [`%${search}%`] : []
    );

    return res.json({ items: rows, page, limit, total: tot?.[0]?.cnt ?? rows.length });
  } catch (e) {
    console.error("[admin.infoproducts.list] fail:", e);
    return res.status(500).json({ error: "list_failed" });
  }
});

/* =========================================
 * CREATE
 * POST /api/admin/infoproducts
 * ========================================= */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const b = await normalizeBody(req.body);

    if (!b.sku || !b.title) {
      return res.status(400).json({ error: "sku_and_title_required" });
    }

    // SKU único
    const { rows: exists } = await query(
      `SELECT 1 FROM infoproducts WHERE LOWER(sku)=LOWER($1) LIMIT 1`,
      [b.sku]
    );
    if (exists.length) return res.status(409).json({ error: "sku_already_exists" });

    const { rows } = await query(
      `
      INSERT INTO infoproducts
        (sku, title, subtitle, description, cover_url, file_url, file_sha256,
         price_cents, default_prize_cents, default_total_numbers,
         active, category_id, category_slug, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,
         $11,$12,$13, NOW(), NOW())
      RETURNING *
      `,
      [
        b.sku, b.title, b.subtitle, b.description, b.cover_url, b.file_url, b.file_sha256,
        b.price_cents, b.default_prize_cents, b.default_total_numbers,
        b.active, b.category_id, b.category_slug
      ]
    );

    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error("[admin.infoproducts.create] fail:", e);
    return res.status(500).json({ error: "create_failed" });
  }
});

/* =========================================
 * UPDATE
 * PUT /api/admin/infoproducts/:id
 * ========================================= */
router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const b = await normalizeBody(req.body);

    // se sku mudou, verifica unicidade
    if (b.sku) {
      const { rows: exists } = await query(
        `SELECT 1 FROM infoproducts WHERE LOWER(sku)=LOWER($1) AND id<>$2 LIMIT 1`,
        [b.sku, id]
      );
      if (exists.length) return res.status(409).json({ error: "sku_already_exists" });
    }

    const { rows } = await query(
      `
      UPDATE infoproducts SET
        sku=$1, title=$2, subtitle=$3, description=$4,
        cover_url=$5, file_url=$6, file_sha256=$7,
        price_cents=$8, default_prize_cents=$9, default_total_numbers=$10,
        active=$11, category_id=$12, category_slug=$13, updated_at=NOW()
      WHERE id=$14
      RETURNING *
      `,
      [
        b.sku, b.title, b.subtitle, b.description,
        b.cover_url, b.file_url, b.file_sha256,
        b.price_cents, b.default_prize_cents, b.default_total_numbers,
        b.active, b.category_id, b.category_slug, id
      ]
    );

    if (!rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error("[admin.infoproducts.update] fail:", e);
    return res.status(500).json({ error: "update_failed" });
  }
});

/* =========================================
 * SOFT DELETE (active=false)
 * DELETE /api/admin/infoproducts/:id
 * ========================================= */
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const { rowCount } = await query(
      `UPDATE infoproducts SET active=false, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[admin.infoproducts.delete] fail:", e);
    return res.status(500).json({ error: "delete_failed" });
  }
});

export default router;
