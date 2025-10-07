// routes/infoprodutos.js
const express = require("express");
const router = express.Router();
// Ajuste o caminho do pool conforme seu projeto:
const pool = require("../db"); // exporta um Pool do node-postgres

// Lista simples de infoprodutos (opcional)
router.get("/", async (req, res) => {
  const { category, withDraws } = req.query;
  const values = [];
  let where = "";
  let join = "";

  if (category) {
    // filtra por categoria (slug ou id) usando relação via draws
    where = `WHERE (c.slug = $1 OR c.id::text = $1)`;
    values.push(category);
  }

  if (String(withDraws) === "1") {
    join = `
      LEFT JOIN draws d ON d.infoproduct_id = p.id
      LEFT JOIN categories c ON c.id = d.category_id
    `;
  } else {
    join = `LEFT JOIN categories c ON c.id = p.category_id`; // se você não tiver category_id em infoproducts, esse join vira LEFT JOIN draws ...
  }

  const sql = `
    SELECT
      p.*,
      c.id   AS category_id,
      c.slug AS category_slug,
      c.name AS category_name,
      c.logo_url,
      ${String(withDraws) === "1" ? `
        d.id    AS draw_id,
        d.status AS draw_status,
        d.prize_cents,
        d.total_numbers,
        COALESCE(d.ticket_price_cents_override, p.price_cents) AS ticket_price_cents
      ` : `
        NULL::int  AS draw_id,
        NULL::text AS draw_status,
        NULL::int  AS prize_cents,
        NULL::int  AS total_numbers,
        p.price_cents AS ticket_price_cents
      `}
    FROM infoproducts p
    ${join}
    ${where}
    ORDER BY c.slug NULLS LAST, p.price_cents ASC;
  `;

  try {
    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "infoproducts_list_failed" });
  }
});

// Seções por categoria com produtos + draw (para a tela)
router.get("/sections", async (req, res) => {
  const { onlyOpen = "1" } = req.query;
  const statusFilter = onlyOpen === "0" ? "" : `AND d.status IN ('open','pending')`;

  const sql = `
    SELECT
      c.id, c.slug, c.name, c.logo_url,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'product', JSON_BUILD_OBJECT(
              'id', p.id, 'sku', p.sku, 'title', p.title, 'subtitle', p.subtitle,
              'description', p.description, 'price_cents', p.price_cents, 'cover_url', p.cover_url
            ),
            'draw', JSON_BUILD_OBJECT(
              'id', d.id, 'status', d.status, 'prize_cents', d.prize_cents,
              'total_numbers', d.total_numbers,
              'ticket_price_cents', COALESCE(d.ticket_price_cents_override, p.price_cents)
            )
          )
          ORDER BY d.prize_cents DESC NULLS LAST
        ) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM draws d
    JOIN categories   c ON c.id = d.category_id
    JOIN infoproducts p ON p.id = d.infoproduct_id
    WHERE 1=1 ${statusFilter}
    GROUP BY c.id, c.slug, c.name, c.logo_url
    ORDER BY c.name;
  `;

  try {
    const { rows } = await pool.query(sql);
    res.json(rows); // [{ id, slug, name, logo_url, items: [ { product:{...}, draw:{...} } ] }]
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "infoproducts_sections_failed" });
  }
});

module.exports = router;
