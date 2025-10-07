// backend/src/routes/infoproducts.js
import express from "express";
import { query } from "../db.js";

const router = express.Router();

/**
 * GET /api/infoproducts
 * Lista e-books (infoprodutos). Suporta:
 *  - ?category=SLUG   -> filtra pelos produtos que estão em draws dessa categoria
 *  - ?status=open     -> (opcional) filtra draws por status ao usar category
 *  - ?page=1&limit=12 -> paginação (default: 1/12; limit máx 50)
 *
 * Retorna { items, page, limit, total } (total é o total de produtos no filtro).
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "12", 10) || 12));
    const offset = (page - 1) * limit;

    const category = (req.query.category ?? "").trim().toLowerCase() || null;
    const status = (req.query.status ?? "").trim().toLowerCase() || null;

    // Quando NÃO filtra por categoria: pega direto de infoproducts
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
      return res.json({
        items: rows,
        page,
        limit,
        total: cRows?.[0]?.cnt ?? rows.length,
      });
    }

    // Com categoria: encontra produtos que estão vinculados a draws dessa categoria
    // (opcionalmente filtra por status = open/closed/etc)
    const params = [];
    let where = `c.slug = $${params.push(category)}`;
    if (status) {
      where += ` AND d.status = $${params.push(status)}`;
    }

    const { rows } = await query(
      `
      SELECT DISTINCT
        p.id, p.sku, p.title, p.subtitle, p.description, p.price_cents, p.cover_url,
        p.created_at, p.updated_at,
        c.id AS category_id, c.slug AS category_slug, c.name AS category_name
      FROM infoproducts p
      JOIN draws d            ON d.infoproduct_id = p.id
      JOIN categories c       ON c.id = d.category_id
      WHERE ${where}
      ORDER BY p.title ASC, p.id ASC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
      `,
      params
    );

    // total para paginação (COUNT DISTINCT)
    const { rows: totalRows } = await query(
      `
      SELECT COUNT(DISTINCT p.id)::int AS cnt
      FROM infoproducts p
      JOIN draws d      ON d.infoproduct_id = p.id
      JOIN categories c ON c.id = d.category_id
      WHERE ${where}
      `,
      params.slice(0, params.length - 2) // remove limit/offset
    );

    return res.json({
      items: rows,
      page,
      limit,
      total: totalRows?.[0]?.cnt ?? rows.length,
    });
  } catch (e) {
    console.error("[infoproducts.index] fail:", e);
    res.status(500).json({ error: "infoproducts_list_failed" });
  }
});

/**
 * GET /api/infoproducts/:idOrSku
 * Retorna um infoproduto pelo ID (numérico) ou SKU (string).
 * Inclui, quando existir, um resumo dos draws vinculados (id, status, prize_cents etc.).
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

    // agrega draws vinculados (caso queira mostrar na página do produto)
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

export default router;
