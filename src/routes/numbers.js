// backend/src/routes/numbers.js
import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// gera duas iniciais a partir do nome; se não tiver nome, usa o usuário do e-mail
function initialsFromNameOrEmail(name, email) {
  const nm = String(name || '').trim();
  if (nm) {
    const parts = nm.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || '');
    return (first + last).toUpperCase();
  }
  const mail = String(email || '').trim();
  const user = mail.includes('@') ? mail.split('@')[0] : mail;
  return user.slice(0, 2).toUpperCase();
}

/**
 * GET /api/numbers
 * - Pega o draw aberto
 * - Lê todos os números do draw (0..99) a partir da tabela numbers
 * - Marca como "sold" (indisponível) os números que têm pagamento aprovado
 * - Marca como "reserved" os números com reserva ativa (não expirada)
 * - Faz lazy-expire das reservas vencidas (best-effort)
 * - Retorna o status final para cada número
 * - (NOVO) Para números vendidos, inclui "owner_initials" (iniciais do comprador)
 */
router.get('/', async (_req, res) => {
  try {
    // 1) draw aberto
    const dr = await query(
      `SELECT id FROM draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`
    );
    if (!dr.rows.length) return res.json({ drawId: null, numbers: [] });
    const drawId = dr.rows[0].id;

    // 2) lista base de números 0..99
    const base = await query(
      `SELECT n FROM numbers WHERE draw_id = $1 ORDER BY n ASC`,
      [drawId]
    );

    // 3) pagos => SOLD + iniciais do comprador
    //    Usamos UNNEST para explodir o array de números pagos
    const pays = await query(
      `
      SELECT
        num.n::int       AS n,
        u.name           AS owner_name,
        u.email          AS owner_email
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      CROSS JOIN LATERAL unnest(p.numbers) AS num(n)
      WHERE p.draw_id = $1
        AND lower(p.status) IN ('approved','paid','pago')
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

    // 4) reservas ativas; ignora expiradas (e tenta expirar em background)
    const resvs = await query(
      `SELECT id, numbers, status, expires_at
         FROM reservations
        WHERE draw_id = $1
          AND lower(coalesce(status,'')) IN ('active','pending','reserved','')`,
      [drawId]
    );

    const now = Date.now();
    const reserved = new Set();

    for (const r of resvs.rows || []) {
      const exp = r.expires_at ? new Date(r.expires_at).getTime() : null;
      const isExpired = exp && !Number.isNaN(exp) && exp < now;

      if (isExpired) {
        // best-effort: não bloqueia a resposta
        query(`UPDATE reservations SET status = 'expired' WHERE id = $1`, [r.id])
          .catch(() => {});
        continue;
      }

      // reserva só se ainda não foi vendida
      for (const n of (r.numbers || [])) {
        const num = Number(n);
        if (!sold.has(num)) reserved.add(num);
      }
    }

    // 5) status final por número (+ owner_initials quando sold)
    const numbers = base.rows.map(({ n }) => {
      const num = Number(n);
      if (sold.has(num)) {
        return { n: num, status: 'sold', owner_initials: initialsByN.get(num) || null };
      }
      if (reserved.has(num)) return { n: num, status: 'reserved' };
      return { n: num, status: 'available' };
    });

    res.json({ drawId, numbers });
  } catch (err) {
    console.error('GET /api/numbers failed', err);
    res.status(500).json({ error: 'failed_to_list_numbers' });
  }
});

export default router;
