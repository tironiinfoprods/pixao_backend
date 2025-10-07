// backend/src/routes/numbers.js
import { Router } from "express";
import { query } from "../db.js";

const router = Router();

/**
 * Gera duas iniciais a partir do nome; se não tiver nome, usa o usuário do e-mail.
 */
function initialsFromNameOrEmail(name, email) {
  const nm = String(name || "").trim();
  if (nm) {
    const parts = nm.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || "";
    const last =
      parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || "";
    return (first + last).toUpperCase();
  }
  const mail = String(email || "").trim();
  const user = mail.includes("@") ? mail.split("@")[0] : mail;
  return user.slice(0, 2).toUpperCase();
}

/**
 * GET /api/numbers
 * Preferencialmente use:  /api/numbers?draw_id=123
 *  - Se draw_id NÃO vier, cai no fallback do último draw 'open'.
 * Retorna: { drawId, numbers: [{ n, status, owner_initials? }] }
 * status ∈ 'available' | 'reserved' | 'sold'
 */
router.get("/", async (req, res) => {
  try {
    // 0) resolve draw_id (param) ou último aberto (fallback)
    let drawId = Number.parseInt(req.query.draw_id ?? "", 10);
    if (!Number.isFinite(drawId)) {
      const dr = await query(
        `SELECT id FROM draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`
      );
      if (!dr.rows.length) {
        return res.json({ drawId: null, numbers: [] });
      }
      drawId = dr.rows[0].id;
    }

    // 1) lista base de números do draw
    let base = await query(
      `SELECT n FROM numbers WHERE draw_id = $1 ORDER BY n ASC`,
      [drawId]
    );

    // fallback: se a tabela 'numbers' ainda não estiver populada,
    // gera o range com base no total_numbers do draw (não bloqueia se não existir)
    if (!base.rows.length) {
      const drInfo = await query(
        `SELECT total_numbers FROM draws WHERE id = $1`,
        [drawId]
      );
      const total = drInfo.rows?.[0]?.total_numbers ?? 100;
      base = {
        rows: Array.from({ length: total }, (_, i) => ({ n: i })),
      };
    }

    // 2) pagos => SOLD + iniciais do comprador
    const pays = await query(
      `
      SELECT
        num.n::int AS n,
        u.name     AS owner_name,
        u.email    AS owner_email
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      CROSS JOIN LATERAL unnest(p.numbers) AS num(n)
      WHERE p.draw_id = $1
        AND lower(coalesce(p.status,'')) IN ('approved','paid','pago','captured','success')
      `,
      [drawId]
    );
    const sold = new Set();
    const initialsByN = new Map();
    for (const row of pays.rows || []) {
      const num = Number(row.n);
      sold.add(num);
      const ini = initialsFromNameOrEmail(row.owner_name, row.owner_email);
      initialsByN.set(num, ini);
    }

    // 3) reservas ativas (ignora expiradas e faz lazy-expire)
    const resvs = await query(
      `
      SELECT id, numbers, status, expires_at
      FROM reservations
      WHERE draw_id = $1
        AND lower(coalesce(status,'')) IN ('active','pending','reserved','')
      `,
      [drawId]
    );

    const now = Date.now();
    const reserved = new Set();

    for (const r of resvs.rows || []) {
      const exp = r.expires_at ? new Date(r.expires_at).getTime() : null;
      const isExpired = exp && !Number.isNaN(exp) && exp < now;

      if (isExpired) {
        // best-effort: não bloqueia a resposta
        query(`UPDATE reservations SET status = 'expired' WHERE id = $1`, [r.id]).catch(
          () => {}
        );
        continue;
      }

      for (const n of r.numbers || []) {
        const num = Number(n);
        if (!sold.has(num)) reserved.add(num);
      }
    }

    // 4) status final por número (+ owner_initials quando sold)
    const numbers = base.rows.map(({ n }) => {
      const num = Number(n);
      if (sold.has(num)) {
        return {
          n: num,
          status: "sold",
          owner_initials: initialsByN.get(num) || null,
        };
      }
      if (reserved.has(num)) return { n: num, status: "reserved" };
      return { n: num, status: "available" };
    });

    return res.json({ drawId, numbers });
  } catch (err) {
    console.error("GET /api/numbers failed", err);
    return res.status(500).json({ error: "failed_to_list_numbers" });
  }
});

export default router;
