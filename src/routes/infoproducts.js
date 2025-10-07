// backend/src/routes/infoproducts.js
import express from "express";
import { query } from "../db.js";

const router = express.Router();

/**
 * GET /api/infoproducts
 * Lista e-books (infoprodutos). Suporta:
 *  - ?category=SLUG   -> tenta via draws/categorias; se vazio, cai no fallback em infoproducts (subtitle/category_slug)
 *  - ?status=open     -> filtra draws por status quando houver category
 *  - ?page=1&limit=12 -> paginação (default: 1/12; limit máx 50)
 *
 * Retorna { items, page, limit, total }.
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "12", 10) || 12));
    const offset = (page - 1) * limit;

    const category = (req.query.category ?? "").trim().toLowerCase() || null;
    const status = (req.query.status ?? "").trim().toLowerCase() || null;

    // Sem category: lista direto de infoproducts
    if (!category) {
      const { rows } = await query(
        `
        SELECT id, sku, title, subtitle, description, price_cents, cover_url,
               created_at, updated_at
        FROM infoproducts
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      );
      const { rows: cRows } = await query(`SELECT COUNT(*)::int AS cnt FROM infoproducts`);
      return res.json({ items: rows, page, limit, total: cRows?.[0]?.cnt ?? rows.length });
    }

    // Com category: 1ª tentativa — JOIN draws+categories (quando já existir draw vinculado)
    const params = [];
    let where = `c.slug = $${params.push(category)}`;
    if (status) where += ` AND d.status = $${params.push(status)}`;

    const { rows: joinRows } = await query(
      `
      SELECT DISTINCT
        p.id, p.sku, p.title, p.subtitle, p.description, p.price_cents, p.cover_url,
        p.created_at, p.updated_at,
        c.id AS category_id, c.slug AS category_slug, c.name AS category_name
      FROM infoproducts p
      JOIN draws d      ON d.infoproduct_id = p.id
      JOIN categories c ON c.id = d.category_id
      WHERE ${where}
      ORDER BY p.title ASC, p.id ASC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
      `,
      params
    );

    if (joinRows.length > 0) {
      const { rows: totalRows } = await query(
        `
        SELECT COUNT(DISTINCT p.id)::int AS cnt
        FROM infoproducts p
        JOIN draws d      ON d.infoproduct_id = p.id
        JOIN categories c ON c.id = d.category_id
        WHERE c.slug = $1 ${status ? "AND d.status = $2" : ""}
        `,
        status ? [category, status] : [category]
      );
      return res.json({
        items: joinRows,
        page,
        limit,
        total: totalRows?.[0]?.cnt ?? joinRows.length,
      });
    }

    // Fallback: ainda não há draws vinculados.
    // Tenta filtrar direto em infoproducts por category em category_slug OU subtitle.
    const { rows: fallbackRows } = await query(
      `
      SELECT id, sku, title, subtitle, description, price_cents, cover_url,
             created_at, updated_at
      FROM infoproducts
      WHERE LOWER(COALESCE(category_slug, '')) = $1
         OR LOWER(COALESCE(subtitle, '')) = $1
         OR LOWER(title) LIKE '%' || $1 || '%'
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
      `,
      [category, limit, offset]
    );

    const { rows: fallbackTotal } = await query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM infoproducts
      WHERE LOWER(COALESCE(category_slug, '')) = $1
         OR LOWER(COALESCE(subtitle, '')) = $1
         OR LOWER(title) LIKE '%' || $1 || '%'
      `,
      [category]
    );

    return res.json({
      items: fallbackRows,
      page,
      limit,
      total: fallbackTotal?.[0]?.cnt ?? fallbackRows.length,
    });
  } catch (e) {
    console.error("[infoproducts.index] fail:", e);
    res.status(500).json({ error: "infoproducts_list_failed" });
  }
});

/**
 * GET /api/infoproducts/:idOrSku
 * Retorna um infoproduto (id numérico ou sku string) + draws vinculados (se houver).
 */
router.get("/:idOrSku", async (req, res) => {
  try {
    const idOrSku = (req.params.idOrSku ?? "").trim();
    const isNumeric = /^\d+$/.test(idOrSku);

    const { rows } = await query(
      `
      SELECT id, sku, title, subtitle, description, price_cents, cover_url,
             created_at, updated_at
      FROM infoproducts
      WHERE ${isNumeric ? "id = $1" : "LOWER(sku) = LOWER($1)"}
      LIMIT 1
      `,
      [idOrSku]
    );

    const product = rows?.[0];
    if (!product) return res.status(404).json({ error: "infoproduct_not_found" });

    const { rows: draws } = await query(
      `
      SELECT d.id, d.status, d.total_numbers, d.prize_cents,
             d.ticket_price_cents_override,
             c.id AS category_id, c.slug AS category_slug, c.name AS category_name
      FROM draws d
      JOIN categories c ON c.id = d.category_id
      WHERE d.infoproduct_id = $1
      ORDER BY d.id DESC
      `,
      [product.id]
    );

    return res.json({ ...product, draws });
  } catch (e) {
    console.error("[infoproducts.show] fail:", e);
    res.status(500).json({ error: "infoproducts_get_failed" });
  }
});

// === GARANTE DRAW ABERTO PARA UM INFOPRODUTO (cria se não existir/estiver cheio) ===

router.post("/:idOrSku/ensure-open-draw", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const idOrSku = (req.params.idOrSku ?? "").trim();
    const isNumeric = /^\d+$/.test(idOrSku);

    // Carrega o e-book + categoria + defaults
    const { rows: pr } = await client.query(
      `
      SELECT
        p.id, p.sku,
        COALESCE(p.category_id, c.id)         AS category_id,
        COALESCE(p.default_total_numbers,100) AS total_numbers,
        COALESCE(p.default_prize_cents,0)     AS prize_cents
      FROM infoproducts p
      LEFT JOIN categories c ON LOWER(c.slug) = LOWER(p.subtitle)  -- fallback
      WHERE ${isNumeric ? "p.id = $1" : "LOWER(p.sku) = LOWER($1)"}
      LIMIT 1
      `,
      [idOrSku]
    );
    const P = pr[0];
    if (!P) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "infoproduct_not_found" });
    }
    if (!P.category_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "infoproduct_missing_category" });
    }

    // Tenta travar o draw "open" mais recente desse produto
    const { rows: drows } = await client.query(
      `
      SELECT id, total_numbers
      FROM draws
      WHERE infoproduct_id = $1 AND status = 'open'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [P.id]
    );

    let drawId = drows[0]?.id ?? null;
    let totalNumbers = drows[0]?.total_numbers ?? P.total_numbers;

    // Se havia draw aberto, veja se encheu
    if (drawId) {
      const { rows: usedRows } = await client.query(
        `
        SELECT COUNT(*)::int AS used
        FROM numbers
        WHERE draw_id = $1 AND status IN ('reserved','taken','sold')
        `,
        [drawId]
      );
      const used = usedRows[0]?.used ?? 0;
      if (used >= totalNumbers) {
        await client.query(
          `UPDATE draws SET status='closed', closed_at=NOW() WHERE id=$1`,
          [drawId]
        );
        drawId = null; // força criar outro
      }
    }

    // Se não há draw aberto ou foi fechado por estar cheio -> cria novo + popula 0..N-1
    if (!drawId) {
      const ins = await client.query(
        `
        INSERT INTO draws (infoproduct_id, category_id, status, total_numbers, prize_cents)
        VALUES ($1,$2,'open',$3,$4)
        RETURNING id, total_numbers
        `,
        [P.id, P.category_id, P.total_numbers, P.prize_cents]
      );
      drawId = ins.rows[0].id;
      totalNumbers = ins.rows[0].total_numbers;

      await client.query(
        `
        INSERT INTO numbers (draw_id, n, status)
        SELECT $1, gs::int, 'available'
        FROM generate_series(0, $2-1) gs
        `,
        [drawId, totalNumbers]
      );
    }

    await client.query("COMMIT");
    return res.json({ draw_id: drawId, total_numbers: totalNumbers });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[ensure-open-draw] fail:", e);
    return res.status(500).json({ error: "ensure_open_draw_failed" });
  } finally {
    client.release();
  }
});


export default router;
