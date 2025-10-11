// backend/src/routes/ebooks.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const exists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

function resolveEbooksDir() {
  const cwd = process.cwd(); // em Render costuma ser /opt/render/project/src
  const candidates = [
    path.join(cwd, 'public', 'ebooks'),                 // ./public/ebooks
    path.join(cwd, '..', 'public', 'ebooks'),           // ../public/ebooks (quando cwd = ./src)
    path.join(__dirname, '..', '..', 'public', 'ebooks'), // from src/routes -> ../../public/ebooks
    path.join(__dirname, '..', 'public', 'ebooks'),     // fallback
    '/opt/render/project/public/ebooks',                // Render (root sem /src)
  ];

  for (const d of candidates) {
    if (exists(d)) return d;
  }

  if (process.env.DEBUG_EBOOKS) {
    console.log('[ebooks] nenhum diretório encontrado. Verificados:', candidates);
  }
  // devolve a primeira opção só para montar o caminho (vai dar 404 depois)
  return candidates[0];
}

router.get('/:sku/download', requireAuth, async (req, res) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'bad_sku' });

    // 1) Confirma se o usuário tem compra aprovada desse SKU
    const ok = await query(
      `
      SELECT 1
      FROM payments p
      JOIN draws d        ON d.id = p.draw_id
      JOIN infoproducts i ON i.id = d.infoproduct_id
      WHERE i.sku = $1
        AND p.user_id = $2
        AND LOWER(p.status) IN ('approved','paid','pago')
      LIMIT 1
      `,
      [sku, req.user.id]
    );
    if (!ok.rows?.length) return res.status(403).json({ error: 'no_access' });

    // 2) Localiza o arquivo físico
    const baseDir = resolveEbooksDir();

    // tenta variações de nome (exato, UPPER, lower)
    const candidates = [
      `${sku}.pdf`,
      `${sku.toUpperCase()}.pdf`,
      `${sku.toLowerCase()}.pdf`,
    ];

    let filePath = null;
    for (const name of candidates) {
      const p = path.join(baseDir, name);
      if (exists(p)) { filePath = p; break; }
    }

    if (!filePath) {
      if (process.env.DEBUG_EBOOKS) {
        console.log(`[ebooks] arquivo não encontrado para SKU ${sku}. Testados:`,
          candidates.map(n => path.join(baseDir, n)));
      }
      return res.status(404).json({ error: 'file_not_found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('[ebooks] fail:', e?.message || e);
    res.status(500).json({ error: 'ebook_download_failed' });
  }
});

// retorna o link do e-book por sorteio, já validando se o usuário tem acesso
router.get('/by-draw/:id', requireAuth, async (req, res) => {
  try {
    const drawId = Number(req.params.id);
    if (!Number.isFinite(drawId)) return res.status(400).json({ error: 'bad_draw_id' });

    const r = await query(
      `
      SELECT i.sku, COALESCE(i.title, 'E-book') AS title
      FROM payments p
      JOIN draws d        ON d.id = p.draw_id
      JOIN infoproducts i ON i.id = d.infoproduct_id
      WHERE p.user_id = $1
        AND d.id = $2
        AND LOWER(p.status) IN ('approved','paid','pago')
      LIMIT 1
      `,
      [req.user.id, drawId]
    );

    if (!r.rows?.length) return res.status(403).json({ error: 'no_access' });

    const { sku, title } = r.rows[0];
    // monta a URL pública do download (ajuste o prefixo se sua API tiver outro basePath)
    const url = `/api/ebooks/${encodeURIComponent(sku)}/download`;
    res.json({ title, url, sku });
  } catch (e) {
    console.error('[ebooks/by-draw] fail:', e?.message || e);
    res.status(500).json({ error: 'ebook_link_failed' });
  }
});


export default router;
