import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getTicketPriceCents } from '../services/config.js';

const router = Router();

async function requireAdmin(req, res, next) {
  try {
    const userId = req.user.id;
    const r = await query('select is_admin from users where id=$1', [userId]);
    if (!r.rows.length || !r.rows[0].is_admin) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  } catch (e) {
    return res.status(500).json({ error: 'admin_check_failed' });
  }
}

router.get('/reservations', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 50)));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }
    const whereSql = where.length ? ('where ' + where.join(' and ')) : '';

    const countSql = `select count(*)::int as total from reservations r ${whereSql}`;
    const countRes = await query(countSql, params);
    const total = countRes.rows[0]?.total || 0;

    const listSql = `
      select r.id, r.user_id, u.email, r.draw_id, r.numbers, r.status, r.created_at, r.expires_at
        from reservations r
        join users u on u.id = r.user_id
        ${whereSql}
       order by r.created_at desc
       limit ${pageSize} offset ${offset}`;
    const listRes = await query(listSql, params);

    const priceCents = await getTicketPriceCents();
    const reservations = listRes.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      email: row.email,
      draw_id: row.draw_id,
      numbers: row.numbers,
      amount_cents: (Array.isArray(row.numbers) ? row.numbers.length : 0) * priceCents,
      status: row.status,
      created_at: row.created_at,
      expires_at: row.expires_at
    }));

    res.json({ reservations, total });
  } catch (e) {
    console.error('[admin/reservations] error:', e);
    res.status(500).json({ error: 'admin_list_failed' });
  }
});

export default router;
