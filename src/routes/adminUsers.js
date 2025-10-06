// backend/src/routes/admin_users.js
// ESM | CRUD de usuários + atribuição de números (isolado deste router)

import express from "express";
import { query, getPool } from "../db.js";

const router = express.Router();

/* =============== helpers =============== */

const mapUser = (r) => ({
  id: Number(r.id),
  name: r.name || "",
  email: r.email || "",
  phone: r.phone || r.celular || "",
  is_admin: !!r.is_admin,
  created_at: r.created_at,
  coupon_code: r.coupon_code || "",
  coupon_value_cents: Number(r.coupon_value_cents || 0),
});

const normStr = (v, max = 255) => String(v ?? "").trim().slice(0, max);
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? (n | 0) : def;
};

// Normaliza "numbers": aceita array ou CSV e retorna int[] 0..99 (mantém 00 como 0)
function parseNumbers(input) {
  if (Array.isArray(input)) {
    return input
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
  }
  const s = String(input || "");
  if (!s) return [];
  return s
    .split(/[,\s;]+/).map((t) => t.trim()).filter(Boolean)
    .map((t) => Number(t))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
}

/* =============== LISTAR (com busca/paginação) =============== */
/**
 * GET /api/admin/users
 * Suporta AMBOS:
 *   - ?q=texto&page=1&pageSize=50
 *   - ?q=texto&limit=50&offset=0
 */
router.get("/", async (req, res, next) => {
  try {
    const { q = "" } = req.query;

    // aceita limit/offset OU page/pageSize
    let limit = toInt(req.query.limit, 0);
    let offset = toInt(req.query.offset, 0);

    if (!(limit > 0)) {
      const page = Math.max(1, toInt(req.query.page, 1));
      const pageSize = Math.min(500, Math.max(1, toInt(req.query.pageSize, 50)));
      limit = pageSize;
      offset = (page - 1) * pageSize;
    } else {
      limit = Math.min(500, Math.max(1, limit));
      offset = Math.max(0, offset);
    }

    const like = `%${String(q).trim()}%`;
    const hasQ = String(q).trim().length > 0;

    const cols = `
      id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents
    `;
    const base = `FROM public.users`;
    const where = hasQ
      ? ` WHERE (name ILIKE $3
                OR email ILIKE $3
                OR phone ILIKE $3
                OR coupon_code ILIKE $3
                OR CAST(id AS text) ILIKE $3)`
      : ``;
    const order = ` ORDER BY id DESC`;
    const limoff = ` LIMIT $1 OFFSET $2`;

    const params = hasQ ? [limit, offset, like] : [limit, offset];

    // total para paginação
    const totalSql = `SELECT COUNT(1)::int AS total ${base}${where}`;
    const listSql  = `SELECT ${cols} ${base}${where}${order}${limoff}`;

    const [countR, listR] = await Promise.all([
      query(totalSql, hasQ ? [like] : []),
      query(listSql, params),
    ]);

    const total = Number(countR.rows?.[0]?.total || 0);
    const items = (listR.rows || []).map(mapUser);

    res.json({
      users: items,
      total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      hasMore: offset + items.length < total,
    });
  } catch (e) {
    next(e);
  }
});

/* =============== OBTER 1 =============== */
/** GET /api/admin/users/:id */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents
         FROM public.users
        WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(mapUser(rows[0]));
  } catch (e) {
    next(e);
  }
});

/* =============== CRIAR =============== */
/** POST /api/admin/users
 * body: { name, email, phone, is_admin, coupon_code?, coupon_value_cents? }
 */
router.post("/", async (req, res, next) => {
  try {
    const {
      name = "",
      email = "",
      phone = "",
      is_admin = false,
      coupon_code = "",
      coupon_value_cents = 0,
    } = req.body || {};

    const vals = [
      normStr(name, 255),
      normStr(email, 255),
      normStr(phone, 40),
      !!is_admin,
      normStr(coupon_code, 64),
      toInt(coupon_value_cents, 0),
    ];

    // Senha padrão "newstore" (hash em bcrypt via pgcrypto)
    const DEFAULT_PASSWORD = "newstore";

    const { rows } = await query(
      `INSERT INTO public.users
         (name, email, phone, is_admin, coupon_code, coupon_value_cents, pass_hash)
       VALUES ($1,$2,$3,$4,$5,$6, crypt($7, gen_salt('bf')))
       RETURNING id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents`,
      [...vals, DEFAULT_PASSWORD]
    );
    res.status(201).json(mapUser(rows[0]));
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "duplicated" });
    next(e);
  }
});

/* =============== ATUALIZAR =============== */
/** PUT /api/admin/users/:id
 * body: { name?, email?, phone?, is_admin?, coupon_code?, coupon_value_cents? }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, email, phone, is_admin, coupon_code, coupon_value_cents } = req.body || {};

    const { rows } = await query(
      `UPDATE public.users
          SET name                 = COALESCE($2, name),
              email                = COALESCE($3, email),
              phone                = COALESCE($4, phone),
              is_admin             = COALESCE($5, is_admin),
              coupon_code          = COALESCE($6, coupon_code),
              coupon_value_cents   = COALESCE($7, coupon_value_cents)
        WHERE id = $1
        RETURNING id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents`,
      [
        id,
        name  != null ? normStr(name, 255)  : null,
        email != null ? normStr(email, 255) : null,
        phone != null ? normStr(phone, 40)  : null,
        typeof is_admin === "boolean" ? !!is_admin : null,
        coupon_code         != null ? normStr(coupon_code, 64) : null,
        coupon_value_cents  != null ? toInt(coupon_value_cents, 0) : null,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(mapUser(rows[0]));
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "duplicated" });
    next(e);
  }
});

/* =============== EXCLUIR =============== */
/** DELETE /api/admin/users/:id */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await query("DELETE FROM public.users WHERE id = $1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

/* =============== ATRIBUIR NÚMEROS =============== */
/**
 * POST /api/admin/users/:id/assign-numbers
 * body: { draw_id: number, numbers: number[] | "csv", amount_cents?: number }
 * - Checa conflitos em payments aprovados e reservas ativas
 * - Se ok, cria:
 *    - payments(status='approved')
 *    - reservations(status='paid')
 */
router.post("/:id/assign-numbers", async (req, res, next) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const user_id = Number(req.params.id);
    const draw_id = Number(req.body?.draw_id);
    const numbers = parseNumbers(req.body?.numbers);
    const amount_cents = Number.isFinite(+req.body?.amount_cents)
      ? Math.max(0, +req.body.amount_cents)
      : 0;

    if (!Number.isInteger(user_id) || !Number.isInteger(draw_id) || numbers.length === 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    await client.query("BEGIN");

    // garante que o usuário existe
    const u = await client.query("SELECT id FROM public.users WHERE id = $1", [user_id]);
    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "user_not_found" });
    }

    // garante sorteio existente
    const d = await client.query("SELECT id FROM public.draws WHERE id = $1", [draw_id]);
    if (!d.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "draw_not_found" });
    }

    // conflitos em payments aprovados
    const payConf = await client.query(
      `SELECT DISTINCT n
         FROM (
           SELECT unnest(p.numbers) AS n
           FROM public.payments p
           WHERE p.draw_id = $1
             AND LOWER(p.status) IN ('approved','paid','pago')
             AND p.numbers && $2::int4[]
         ) s
         WHERE n = ANY ($2::int4[])`,
      [draw_id, numbers]
    );
    if (payConf.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "numbers_taken",
        where: "payments",
        conflicts: payConf.rows.map((r) => Number(r.n)).sort((a, b) => a - b),
      });
    }

    // conflitos em reservas ativas (somente pelo array)
    const resvConf = await client.query(
      `SELECT DISTINCT n
         FROM (
           SELECT unnest(r.numbers) AS n
           FROM public.reservations r
           WHERE r.draw_id = $1
             AND LOWER(r.status) IN ('active','pending','paid')
             AND r.numbers && $2::int4[]
         ) x
         WHERE n = ANY ($2::int4[])`,
      [draw_id, numbers]
    );
    if (resvConf.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "numbers_reserved",
        where: "reservations",
        conflicts: resvConf.rows.map((r) => Number(r.n)).sort((a, b) => a - b),
      });
    }

    // --------- INSERTS ---------
    // payments.id é NOT NULL (tipo text); usamos epoch ms (13 dígitos) como nos seus dados atuais
    const payId = Date.now().toString();

    const pay = await client.query(
      `INSERT INTO public.payments
         (id, user_id, draw_id, numbers, amount_cents, status, created_at)
       VALUES ($1, $2, $3, $4::int4[], $5, 'approved', NOW())
       RETURNING id, user_id, draw_id, numbers, amount_cents, status, created_at`,
      [payId, user_id, draw_id, numbers, amount_cents]
    );

    // reserva paga; PK uuid gerada pelo banco
    const resv = await client.query(
      `INSERT INTO public.reservations
         (id, user_id, draw_id, numbers, status, created_at, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3::int4[], 'paid', NOW(), NOW() + INTERVAL '30 minutes')
       RETURNING id`,
      [user_id, draw_id, numbers]
    );

    await client.query("COMMIT");
    res.status(201).json({
      payment: pay.rows[0],
      reservation_id: resv.rows[0]?.id || null,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    next(e);
  } finally {
    client.release();
  }
});

export default router;
