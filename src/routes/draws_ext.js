import { Router } from 'express';
import { query } from '../db.js';
const router = Router();

router.get('/:id/numbers', async (req, res) => {
  try {
    const drawId = Number(req.params.id);
    if (!drawId) return res.json({ numbers: [] });
    const r = await query('select n, status from numbers where draw_id=$1 order by n asc', [drawId]);
    const numbers = r.rows.map(x => ({ n: x.n, status: x.status }));
    res.json({ numbers });
  } catch (e) {
    console.error('[draws/:id/numbers] error:', e);
    res.status(500).json({ error: 'numbers_failed' });
  }
});

export default router;
