// backend/src/routes/ebooks.js
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db.js';

const router = express.Router();

/** Normaliza SKU e evita path traversal */
function normalizeSku(raw) {
  const s = String(raw || '').trim();
  // mantém letras, números, hífen e underscore
  return s.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Procura o arquivo <SKU>.pdf no diretório informado, de forma case-insensitive */
function findPdfForSku(baseDir, sku) {
  // candidatos diretos (respeitando o case mais comum)
  const direct = [
    path.join(baseDir, `${sku}.pdf`),
    path.join(baseDir, `${sku}.PDF`),
  ];
  for (const p of direct) {
    if (fs.existsSync(p)) return p;
  }

  // varre o diretório uma vez e tenta match case-insensitive
  try {
    const files = fs.readdirSync(baseDir, { withFileTypes: true });
    const want = sku.toLowerCase();
    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name).toLowerCase();
      if (ext !== '.pdf') continue;
      const nameNoExt = path.basename(f.name, ext).toLowerCase();
      if (nameNoExt === want) {
        return path.join(baseDir, f.name);
      }
    }
  } catch {
    // se não conseguir ler o diretório, cai fora sem erro
  }

  return null;
}

router.get('/:sku/download', requireAuth, async (req, res) => {
  try {
    const rawSku = normalizeSku(req.params.sku);
    const sku = rawSku.toUpperCase(); // nossos arquivos/sku são em maiúsculas

    if (!sku) {
      return res.status(400).json({ error: 'bad_sku' });
    }

    // 1) Confirma se o usuário tem compra aprovada desse SKU (case-insensitive)
    const ok = await query(
      `
      SELECT 1
        FROM payments p
        JOIN draws d         ON d.id  = p.draw_id
        JOIN infoproducts i  ON i.id  = d.infoproduct_id
       WHERE LOWER(i.sku) = LOWER($1)
         AND p.user_id      = $2
         AND LOWER(p.status) IN ('approved','paid','pago')
       LIMIT 1
      `,
      [sku, req.user.id]
    );

    if (!ok?.rows?.length) {
      return res.status(403).json({ error: 'no_access' });
    }

    // 2) Resolve o arquivo físico
    const baseDir = path.join(process.cwd(), 'public', 'ebooks');
    const filePath = findPdfForSku(baseDir, sku);

    if (!filePath) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // 3) Stream do PDF
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(stat.size));
    // nome do arquivo bonito no download
    const downloadName = `${sku}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    // opcional: reduzir buffering em alguns proxies
    res.setHeader('X-Accel-Buffering', 'no');

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'stream_error' });
      else res.end();
    });
    stream.pipe(res);
  } catch (e) {
    console.error('[ebooks.download] error:', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
