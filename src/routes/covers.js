// backend/src/routes/covers.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function resolveCoversDir() {
  const cwd = process.cwd(); // Render: /opt/render/project/src
  const candidates = [
    path.join(cwd, 'public', 'covers'),
    path.join(__dirname, '..', 'public', 'covers'),
    path.join(__dirname, '..', '..', 'public', 'covers'),
    '/opt/render/project/public/covers', // fallback extra
  ];
  for (const d of candidates) if (exists(d)) return d;
  return candidates[0];
}

const COVERS_DIR = resolveCoversDir();

// /static/covers/<arquivo>.jpg (apenas basename, evita traversal)
router.get('/:file', (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  const ext = path.extname(file).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
    return res.status(400).json({ error: 'bad_extension' });
  }

  const full = path.join(COVERS_DIR, file);
  if (!exists(full)) {
    return res.status(404).json({ error: 'not_found', path: `/static/covers/${file}` });
  }

  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.sendFile(full);
});

export default router;
