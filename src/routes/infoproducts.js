import express from "express";
import { query, getPool } from "../db.js";

const router = express.Router();

/* ======================================================================== */
/* helpers                                                                  */
/* ======================================================================== */

async function findProductByIdOrSku(client, idOrSku) {
  const isNumeric = /^\d+$/.test(String(idOrSku || "").trim());
  const { rows } = await client.query(
    `
    SELECT
      id, sku, title, subtitle, description, cover_url,
      price_cents,
      default_prize_cents AS prize_cents,
      default_total_numbers,
      category_slug, category_id,
      created_at, updated_at,
      active
    FROM infoproducts
    WHERE ${isNumeric ? "id = $1" : "LOWER(sku) = LOWER($1)"}
    LIMIT 1
    `,
    [idOrSku]
  );
  return rows?.[0] || null;
}

async function findOpenDrawForProduct(client, productId) {
  // sorteio aberto mais recente
  const { rows } = await client.query(
    `
    SELECT
      d.id, d.status, d.total_numbers, d.prize_cents,
      d.ticket_price_cents_override, d.cover_url, d.category_id,
      d.created_at, d.updated_at
    FROM draws d
    WHERE d.infoproduct_id = $1
      AND d.status = 'open'
    ORDER BY d.id DESC
    LIMIT 1
    `,
    [productId]
  );
  return rows?.[0] || null;
}

async function findLatestDrawForProduct(client, productId) {
  // caso não exista aberto, pega o mais recente (fechado)
  const { rows } = await client.query(
    `
    SELECT
      d.id, d.status, d.total_numbers, d.prize_cents,
      d.ticket_price_cents_override, d.cover_url, d.category_id,
      d.created_at, d.updated_at
    FROM draws d
    WHERE d.infoproduct_id = $1
    ORDER BY d.id DESC
    LIMIT 1
    `,
    [productId]
  );
  return rows?.[0] || null;
}

async function loadNumbersForDraw(client, drawId) {
  // sempre filtra por draw_id (para não "vazar" números de outro sorteio)
  const { rows } = await client.query(
    `
    SELECT n::int AS n, status
    FROM numbers
    WHERE draw_id = $1
    ORDER BY n ASC
    `,
    [drawId]
  );
  return rows?.map(r => ({ n: Number(r.n), status: r.status })) || [];
}

async function loadCountsForDraw(client, drawId) {
  const { rows } = await client.query(
    `
    SELECT status, COUNT(*)::int AS qty
    FROM numbers
    WHERE draw_id = $1
    GROUP BY status
    `,
    [drawId]
  );
  const acc = { available: 0, reserved: 0, sold: 0, taken: 0 };
  for (const r of rows) {
    const k = String(r.status || "").toLowerCase();
    if (acc[k] != null) acc[k] = r.qty;
  }
  return acc;
}

/* ======================================================================== */
/* LISTA de infoprodutos (igual ao seu código atual)                         */
/* ======================================================================== */

/**
 * GET /api/infoproducts
 * ?category=SLUG (opcional)
 * ?status=open   (opcional, quando category presente)
 * ?page=1&limit=12
 *
 * Retorna { items, page, limit, total }.
 * Cada item já inclui `prize_cents` (alias de default_prize_cents).
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
        SELECT
          id, sku, title, subtitle, description, cover_url,
          price_cents,
          default_prize_cents AS prize_cents,
          default_total_numbers,
          category_slug, category_id,
          created_at, updated_at
        FROM infoproducts
        WHERE active = true
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      );
      const { rows: cRows } = await query(
        `SELECT COUNT(*)::int AS cnt FROM infoproducts WHERE active = true`
      );
      return res.json({ items: rows, page, limit, total: cRows?.[0]?.cnt ?? rows.length });
    }

    // Com category: tenta por draws + categories primeiro
    const params = [];
    let where = `LOWER(c.slug) = $${params.push(category)}`;
    if (status) where += ` AND LOWER(d.status) = $${params.push(status)}`;

    const { rows: joinRows } = await query(
      `
      SELECT DISTINCT
        p.id, p.sku, p.title, p.subtitle, p.description, p.cover_url,
        p.price_cents,
        p.default_prize_cents AS prize_cents,
        p.default_total_numbers,
        p.category_slug, p.category_id,
        p.created_at, p.updated_at,
        c.id AS category_id_from_draw, c.slug AS category_slug_from_draw, c.name AS category_name
      FROM infoproducts p
      JOIN draws d      ON d.infoproduct_id = p.id
      JOIN categories c ON c.id = d.category_id
      WHERE ${where} AND p.active = true
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
        WHERE LOWER(c.slug) = $1
          AND p.active = true
          ${status ? "AND LOWER(d.status) = $2" : ""}
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

    // Fallback: filtra diretamente por infoproducts.category_slug / subtitle / title
    const { rows: fallbackRows } = await query(
      `
      SELECT
        id, sku, title, subtitle, description, cover_url,
        price_cents,
        default_prize_cents AS prize_cents,
        default_total_numbers,
        category_slug, category_id,
        created_at, updated_at
      FROM infoproducts
      WHERE active = true
        AND (
             LOWER(COALESCE(category_slug,'')) = $1
          OR LOWER(COALESCE(subtitle,'')) = $1
          OR LOWER(title) LIKE '%' || $1 || '%'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
      `,
      [category, limit, offset]
    );

    const { rows: fallbackTotal } = await query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM infoproducts
      WHERE active = true
        AND (
             LOWER(COALESCE(category_slug,'')) = $1
          OR LOWER(COALESCE(subtitle,'')) = $1
          OR LOWER(title) LIKE '%' || $1 || '%'
        )
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

/* ======================================================================== */
/* SHOW do infoproduto (igual ao seu)                                       */
/* ======================================================================== */

/**
 * GET /api/infoproducts/:idOrSku
 * Retorna infoproduto + draws vinculados (se houver).
 * prize_cents = default_prize_cents (alias).
 */
router.get("/:idOrSku", async (req, res) => {
  try {
    const idOrSku = (req.params.idOrSku ?? "").trim();
    const isNumeric = /^\d+$/.test(idOrSku);

    const { rows } = await query(
      `
      SELECT
        id, sku, title, subtitle, description, cover_url,
        price_cents,
        default_prize_cents AS prize_cents,
        default_total_numbers,
        category_slug, category_id,
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
      SELECT
        d.id, d.status, d.total_numbers, d.prize_cents,
        d.ticket_price_cents_override, d.cover_url,
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

/* ======================================================================== */
/* NOVOS ENDPOINTS: open-draw (único e em lote)                              */
/* ======================================================================== */

/**
 * GET /api/infoproducts/:idOrSku/open-draw
 * ?include=numbers   -> inclui a grade de números do draw (filtrada por draw_id)
 *
 * Retorna:
 * {
 *   product: {...},
 *   draw: { id, status, total_numbers, prize_cents, ticket_price_cents_override, counts: {available,reserved,sold,taken} },
 *   numbers?: [{ n, status }, ...]
 * }
 */
router.get("/:idOrSku/open-draw", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const include = String(req.query.include || "").toLowerCase();
    const wantNumbers = include.split(",").map(s => s.trim()).includes("numbers");

    const idOrSku = (req.params.idOrSku || "").trim();
    if (!idOrSku) return res.status(400).json({ error: "bad_request" });

    const product = await findProductByIdOrSku(client, idOrSku);
    if (!product) return res.status(404).json({ error: "infoproduct_not_found" });
    if (product.active === false) return res.status(403).json({ error: "infoproduct_inactive" });

    let draw = await findOpenDrawForProduct(client, product.id);
    if (!draw) draw = await findLatestDrawForProduct(client, product.id);
    if (!draw) return res.json({ product, draw: null, numbers: wantNumbers ? [] : undefined });

    const counts = await loadCountsForDraw(client, draw.id);
    const payload = {
      product,
      draw: {
        ...draw,
        counts,
      },
    };

    if (wantNumbers) {
      const numbers = await loadNumbersForDraw(client, draw.id);
      payload.numbers = numbers;
    }

    return res.json(payload);
  } catch (e) {
    console.error("[infoproducts.open-draw] fail:", e);
    return res.status(500).json({ error: "open_draw_failed" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/infoproducts/open-draws
 * Lista em lote:
 *   - por ids:  ?ids=10,11,12
 *   - por skus: ?skus=LM-BRONZE,LM-OURO,LM-PRATA
 *   - ?include=numbers  (opcional)
 *
 * Retorna: { items: [{ product_id, product_sku, draw, numbers? }...] }
 */
router.get("/open-draws", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const include = String(req.query.include || "").toLowerCase();
    const wantNumbers = include.split(",").map(s => s.trim()).includes("numbers");

    const idsRaw = String(req.query.ids || "").trim();
    const skusRaw = String(req.query.skus || "").trim();

    const ids = idsRaw ? idsRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    const skus = skusRaw ? skusRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!ids.length && !skus.length) {
      return res.status(400).json({ error: "provide_ids_or_skus" });
    }

    const wanted = [...ids, ...skus];
    const out = [];

    for (const key of wanted) {
      const product = await findProductByIdOrSku(client, key);
      if (!product) {
        out.push({ key, error: "infoproduct_not_found" });
        continue;
      }
      if (product.active === false) {
        out.push({ key, product_id: product.id, product_sku: product.sku, error: "infoproduct_inactive" });
        continue;
      }

      let draw = await findOpenDrawForProduct(client, product.id);
      if (!draw) draw = await findLatestDrawForProduct(client, product.id);

      if (!draw) {
        out.push({ key, product_id: product.id, product_sku: product.sku, draw: null, numbers: wantNumbers ? [] : undefined });
        continue;
      }

      const counts = await loadCountsForDraw(client, draw.id);
      const item = {
        key,
        product_id: product.id,
        product_sku: product.sku,
        draw: { ...draw, counts },
      };

      if (wantNumbers) {
        item.numbers = await loadNumbersForDraw(client, draw.id);
      }

      out.push(item);
    }

    return res.json({ items: out });
  } catch (e) {
    console.error("[infoproducts.open-draws] fail:", e);
    return res.status(500).json({ error: "open_draws_failed" });
  } finally {
    client.release();
  }
});

/* ======================================================================== */
/* ensure-open-draw (igual ao seu)                                          */
/* ======================================================================== */

/**
 * POST /api/infoproducts/:idOrSku/ensure-open-draw
 * Garante rodada aberta para o e-book (cria se lotou/não existir),
 * usando default_prize_cents e default_total_numbers.
 */
router.post("/:idOrSku/ensure-open-draw", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const idOrSku = (req.params.idOrSku ?? "").trim();
    const isNumeric = /^\d+$/.test(idOrSku);

    // carrega e-book + categoria + defaults
    const { rows: pr } = await client.query(
      `
      SELECT
        p.id, p.sku,
        COALESCE(p.category_id, c.id)          AS category_id,
        COALESCE(p.default_total_numbers,100)  AS total_numbers,
        COALESCE(p.default_prize_cents,0)      AS prize_cents
      FROM infoproducts p
      LEFT JOIN categories c ON LOWER(c.slug) = LOWER(p.category_slug)
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

    // trava o draw aberto mais recente do produto
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

    // se tinha draw aberto, verifica se encheu
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
        drawId = null;
      }
    }

    // cria novo draw se não houver aberto
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
