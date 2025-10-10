// backend/src/routes/ebooks.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db.js';

const router = express.Router();

// resolve diretório do arquivo atual (para não depender só do process.cwd())
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Candidatos de diretórios onde o PDF pode estar no deploy
const EBOOK_DIR_CANDIDATES = [
  path.resolve(process.cwd(), 'public', 'ebooks'),
  path.resolve(process.cwd(), './public/ebooks'),
  path.resolve(__dirname, '..', '..', 'public', 'ebooks'),
  path.resolve('.', 'public', 'ebooks'),
];

function tryFindFile(baseDir, sku) {
  const candidates = [
    `${sku}.pdf`,
    `${String(sku).toUpperCase()}.pdf`,
    `${String(sku).toLowerCase()}.pdf`,
    // tenta título capitalizado (LM-PRATA -> Lm-Prata)
    `${String(sku).toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}.pdf`,
  ];
  for (const name of candidates) {
    const p = path.join(baseDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

router.get('/:sku/download', requireAuth, async (req, res) => {
  try {
    const rawSku = String(req.params.sku || '').trim();
    // normaliza contra injeção e espaços
    const sku = rawSku.replace(/[^A-Za-z0-9._-]/g, '');

    // 1) Confirma se o usuário tem compra aprovada desse SKU
    const ok = await query(
      `
      SELECT 1
        FROM payments p
        JOIN draws d         ON d.id = p.draw_id
        JOIN infoproducts i  ON i.id = d.infoproduct_id
       WHERE i.sku = $1
         AND p.user_id = $2
         AND LOWER(p.status) IN ('approved','paid','pago')
       LIMIT 1
      `,
      [sku, req.user.id]
    );

    if (!ok.rows.length) {
      return res.status(403).json({ error: 'no_access' });
    }

    // 2) Encontra o arquivo físico (varrendo candidatos)
    let filePath = null;
    for (const base of EBOOK_DIR_CANDIDATES) {
      const found = tryFindFile(base, sku);
      // log leve para depurar no Render
      console.log('[ebooks] check dir:', base, 'found:', !!found);
      if (found) { filePath = found; break; }
    }

    if (!filePath) {
      console.warn('[ebooks] file not found for SKU:', sku, 'candidates:', EBOOK_DIR_CANDIDATES);
      return res.status(404).json({ error: 'file_not_found' });
    }

    // 3) Stream/download
    res.setHeader('Content-Type', 'application/pdf');
    // Sugere nome do arquivo no download
    res.setHeader('Content-Disposition', `attachment; filename="${sku}.pdf"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('[ebooks] fail:', e?.message || e);
    res.status(500).json({ error: 'ebook_download_failed' });
  }
});

export default router;
