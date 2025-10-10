// backend/src/routes/ebooks.js
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db.js';

const router = express.Router();

router.get('/:sku/download', requireAuth, async (req, res) => {
  const sku = String(req.params.sku||'').trim();

  // 1) confirma se o usuário tem compra aprovada desse SKU
  const ok = await query(`
    SELECT 1
    FROM payments p
    JOIN draws d ON d.id = p.draw_id
    JOIN infoproducts i ON i.id = d.infoproduct_id
    WHERE i.sku = $1
      AND p.user_id = $2
      AND LOWER(p.status) IN ('approved','paid','pago')
    LIMIT 1
  `, [sku, req.user.id]);

  if (!ok.rows.length) return res.status(403).json({ error: 'no_access' });

  // 2) encontra o arquivo físico
  const filePath = path.join(process.cwd(), 'public', 'ebooks', `${sku}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${sku}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
