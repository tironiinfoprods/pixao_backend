// src/middleware/auth.js
import jwt from 'jsonwebtoken';


const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_KEY ||
  process.env.SUPABASE_JWT_SECRET ||
  'change-me-in-env';

// você pode manter AUTH_COOKIE_NAME, mas também aceitaremos nomes comuns
const COOKIE_NAMES = [
  process.env.AUTH_COOKIE_NAME || 'ns_auth',
  'ns_auth_token',
  'token',
  'jwt',
];

function sanitizeToken(t) {
  if (!t) return '';
  let s = String(t).trim();
  // remove "Bearer " se vier no header
  if (/^Bearer\s+/i.test(s)) s = s.replace(/^Bearer\s+/i, '').trim();
  // remove aspas acidentais
  s = s.replace(/^['"]|['"]$/g, '');
  return s;
}

function extractToken(req) {
  // 1) Authorization
  const auth = req.headers?.authorization;
  if (auth) {
    const tok = sanitizeToken(auth);
    if (tok) return tok;
  }

  // 2) Cookies
  const cookies = req.cookies || {};
  for (const name of COOKIE_NAMES) {
    if (cookies[name]) {
      const tok = sanitizeToken(cookies[name]);
      if (tok) return tok;
    }
  }

  return null;
}

export function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });

    const payload = jwt.verify(token, JWT_SECRET);

    // anexa um usuário mínimo no req
    req.user = {
      id: payload.id || payload.sub,
      email: payload.email || payload.user?.email,
      role: payload.role || payload.user?.role,
      ...payload,
    };

    return next();
  } catch (e) {
    console.warn('[auth] invalid token:', e?.message || e);
    return res.status(401).json({ error: 'unauthorized' });
  }
}

export function requireAdmin(req, res, next) {
  const u = req.user;
  if (!u || !(u.role === 'admin' || u.is_admin === true)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}


