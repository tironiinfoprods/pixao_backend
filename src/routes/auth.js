// backend/src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  'change-me-in-env';

const TOKEN_TTL   = process.env.JWT_TTL || '7d';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'ns_auth';
const IS_PROD     = (process.env.NODE_ENV || 'production') === 'production';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

async function verifyPassword(plain, hashed) {
  if (!hashed) return false;
  try {
    const h = String(hashed);
    if (h.startsWith('$2')) return await bcrypt.compare(String(plain), h); // bcrypt
    if (!h.startsWith('$')) return String(plain) === h; // legado texto-plain
    return false;
  } catch {
    return false;
  }
}

// ---------- util: garantir colunas que usamos ----------
async function ensureUserColumns() {
  try {
    await query(`
      ALTER TABLE IF EXISTS users
        ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS coupon_code text,
        ADD COLUMN IF NOT EXISTS coupon_updated_at timestamptz,
        ADD COLUMN IF NOT EXISTS tray_coupon_id text,
        ADD COLUMN IF NOT EXISTS coupon_value_cents int4 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS phone text
    `);
  } catch (e) {
    // ok ignorar; se não conseguir, o fallback do hydrate cobre
  }
}

// ====== KYC helpers/columns ======
function onlyDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}
function isValidCPF(raw) {
  const cpf = onlyDigits(raw);
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  // dígito 1
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i], 10) * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  if (d1 !== parseInt(cpf[9], 10)) return false;

  // dígito 2
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i], 10) * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;
  return d2 === parseInt(cpf[10], 10);
}
function parseBirthdate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let y, m, d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    [y, m, d] = s.split('-').map(Number);
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yy] = s.split('/').map(Number);
    y = yy; m = mm; d = dd;
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return Number.isNaN(dt.getTime()) ? null : dt;
}
function yearsBetween(a, b) {
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  const m = b.getUTCMonth() - a.getUTCMonth();
  const d = b.getUTCDate() - a.getUTCDate();
  if (m < 0 || (m === 0 && d < 0)) y--;
  return y;
}
async function ensureKycColumns() {
  try {
    await query(`
      ALTER TABLE IF EXISTS users
        ADD COLUMN IF NOT EXISTS cpf text,
        ADD COLUMN IF NOT EXISTS cpf_verified boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS birthdate date,
        ADD COLUMN IF NOT EXISTS kyc_status text DEFAULT 'pending'
    `);
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_cpf_unique_idx ON users (cpf) WHERE cpf IS NOT NULL`
    );
  } catch (e) {
    console.warn('[auth/kyc] ensureKycColumns warn:', e.code || e.message || e);
  }
}

// Gera um cupom determinístico por usuário (só se ainda não existir)
function makeUserCouponCode(userId) {
  const id = Number(userId || 0);
  const base = `NSU-${String(id).padStart(4, '0')}`;
  const salt = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const tail = salt[(id * 7) % salt.length] + salt[(id * 13) % salt.length];
  return `${base}-${tail}`;
}

// Carrega usuário do DB (tolerante a colunas ausentes)
async function hydrateUserFromDB(id, email) {
  await ensureUserColumns();

  try {
    let r = null;
    if (id) {
      r = await query(
        `SELECT id, name, email, is_admin, coupon_code, coupon_updated_at, coupon_value_cents
           FROM users WHERE id=$1 LIMIT 1`,
        [id]
      );
    }
    if ((!r || !r.rows.length) && email) {
      r = await query(
        `SELECT id, name, email, is_admin, coupon_code, coupon_updated_at, coupon_value_cents
           FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        [email]
      );
    }
    if (!r || !r.rows.length) return null;

    let u = r.rows[0];

    // cria o coupon_code se ainda não existir
    if (!u.coupon_code) {
      const code = makeUserCouponCode(u.id);
      const upd = await query(
        `UPDATE users
            SET coupon_code=$2, coupon_updated_at=NOW()
          WHERE id=$1
        RETURNING id, name, email, is_admin, coupon_code, coupon_updated_at, coupon_value_cents`,
        [u.id, code]
      );
      u = upd.rows[0];
    }

    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.is_admin ? 'admin' : 'user',
      coupon_code: u.coupon_code || null,
      coupon_updated_at: u.coupon_updated_at || null,
      coupon_value_cents: Number(u.coupon_value_cents || 0),
    };
  } catch {
    // fallback minimalista
    const r = await query(
      `SELECT id, name, email
         FROM users
        WHERE ${id ? 'id = $1' : 'LOWER(email)=LOWER($1)'}
        LIMIT 1`,
      [id || email]
    );
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: 'user',
      coupon_code: null,
      coupon_updated_at: null,
      coupon_value_cents: 0,
    };
  }
}

// Busca usuário por e-mail cobrindo colunas/tabelas legadas
async function findUserByEmail(emailRaw) {
  const email = String(emailRaw).trim();
  try { await query('SELECT 1', []); } catch {}

  const variants = [
    { sql: `SELECT id, email, pass_hash AS hash, CASE WHEN is_admin THEN 'admin' ELSE 'user' END AS role
            FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, args: [email] },
    { sql: `SELECT id, email, password_hash AS hash, CASE WHEN is_admin THEN 'admin' ELSE 'user' END AS role
            FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, args: [email] },
    { sql: `SELECT id, email, password AS hash, CASE WHEN is_admin THEN 'admin' ELSE 'user' END AS role
            FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, args: [email] },
    { sql: `SELECT id, email, password_hash AS hash, role FROM admin_users
            WHERE LOWER(email)=LOWER($1) LIMIT 1`, args: [email] },
    { sql: `SELECT id, email, password AS hash, 'admin' AS role FROM admins
            WHERE LOWER(email)=LOWER($1) LIMIT 1`, args: [email] },
  ];

  for (const v of variants) {
    try {
      const { rows } = await query(v.sql, v.args);
      if (rows && rows.length) return rows[0];
    } catch {
      // ignora 42P01/42703 etc. e tenta a próxima
    }
  }
  return null;
}

// ======= envio de e-mail robusto (Brevo) =======
async function sendResetMailBrevo(to, newPassword) {
  const HOST = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const USER = process.env.SMTP_USER || '';          // sua credencial SMTP do Brevo
  const PASS = process.env.SMTP_PASS || '';          // sua senha/SMTP key do Brevo

  // REMETENTE: precisa ser um sender/domínio VALIDADO no Brevo
  const FROM_EMAIL = process.env.SMTP_FROM || 'contato@pixaonamao.com.br';
  const FROM_NAME  = process.env.SMTP_FROM_NAME || 'Pixão Na Mão';
  const REPLY_TO   = process.env.SMTP_REPLY_TO || FROM_EMAIL;

  // Evita usar USER como "from" (causa rejeição 9712be001@smtp-brevo.com)
  if (/smtp-brevo\.com$/i.test(FROM_EMAIL)) {
    throw new Error('invalid_from_sender_not_verified');
  }

  const attempts = [
    { port: Number(process.env.SMTP_PORT || 587), secure: false, label: '587 STARTTLS' },
    { port: 465, secure: true,  label: '465 TLS' },
    { port: 2525, secure: false, label: '2525 STARTTLS' },
  ];

  const baseMail = {
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to,
    replyTo: REPLY_TO,
    subject: 'Reset de senha - Pixão Na Mão',
    text:
      `Sua senha foi resetada.\n\n` +
      `Nova Senha: ${newPassword}\n\n` +
      `Se você não solicitou, ignore este e-mail.`,
  };

  let lastErr = null;

  for (const opt of attempts) {
    try {
      const transporter = nodemailer.createTransport({
        host: HOST,
        port: opt.port,
        secure: opt.secure,               // 465 = TLS direto; 587/2525 = STARTTLS
        auth: USER ? { user: USER, pass: PASS } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        tls: {
          minVersion: 'TLSv1.2',
          servername: HOST,
          rejectUnauthorized: false,      // Render free às vezes tem cadeias CA antigas
        },
      });

      console.log(`[reset-password] tentando SMTP ${HOST}:${opt.port} (${opt.label}) from=${FROM_NAME} <${FROM_EMAIL}>`);

      await transporter.verify().catch(() => {});
      await transporter.sendMail(baseMail);

      console.log(`[reset-password] e-mail enviado via Brevo (${opt.label})`);
      return true;
    } catch (e) {
      lastErr = e;
      console.warn(`[reset-password] tentativa falhou (${opt.label}):`, e?.code || e?.message || e);
    }
  }

  throw lastErr || new Error('smtp_unavailable');
}

// ===================== ROTAS =====================

/**
 * POST /api/register    (este arquivo costuma ser montado em /api)
 * Recebe KYC + dados básicos. Mantém as outras rotas inalteradas.
 */
router.post('/register', async (req, res) => {
  try {
    const {
      name, email, password, phone,
      cpf, birthdate, acceptTerms,
    } = req.body || {};

    if (!name || !email || !password || !phone || !cpf || !birthdate) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    if (!acceptTerms) {
      return res.status(400).json({ error: 'terms_not_accepted' });
    }

    const emailNorm = String(email).trim().toLowerCase();
    const phoneNorm = onlyDigits(phone);
    const cpfDigits = onlyDigits(cpf);

    if (!isValidCPF(cpfDigits)) return res.status(400).json({ error: 'invalid_cpf' });

    const bdt = parseBirthdate(birthdate);
    if (!bdt) return res.status(400).json({ error: 'invalid_birthdate' });
    const age = yearsBetween(bdt, new Date());
    if (age < 18) return res.status(400).json({ error: 'underage' });

    await ensureUserColumns();
    await ensureKycColumns();

    const dupeEmail = await query('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)', [emailNorm]);
    if (dupeEmail.rows.length) return res.status(409).json({ error: 'email_in_use' });

    const dupeCpf = await query('SELECT 1 FROM users WHERE cpf=$1', [cpfDigits]);
    if (dupeCpf.rows.length) return res.status(409).json({ error: 'cpf_in_use' });

    const hash = await bcrypt.hash(String(password), 10);
    const ins = await query(
      `INSERT INTO users (name, email, pass_hash, phone, cpf, cpf_verified, birthdate, kyc_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, email, phone, cpf, cpf_verified, birthdate,
                 CASE WHEN is_admin THEN 'admin' ELSE 'user' END AS role`,
      [
        name,
        emailNorm,
        hash,
        phoneNorm || null,
        cpfDigits,
        true,
        bdt.toISOString().slice(0,10),
        'verified',
      ]
    );

    const u = ins.rows[0];
    const token = signToken({ sub: u.id, email: u.email, name: u.name, role: u.role });

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone,
        cpf: u.cpf ? u.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : null,
        cpf_verified: !!u.cpf_verified,
        birthdate: u.birthdate,
      },
    });
  } catch (e) {
    console.error('[auth] register error', e.code || e.message || e);
    return res.status(503).json({ error: 'db_unavailable' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const user = await findUserByEmail(email);
    if (!user || !user.hash) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const ok = await verifyPassword(password, user.hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken({ sub: user.id, email: user.email, role: user.role || 'user' });

    const full = await hydrateUserFromDB(user.id, user.email) || {
      id: user.id, email: user.email, role: user.role || 'user',
    };

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, token, user: full });
  } catch (e) {
    console.error('[auth] login error', e.code || e.message || e);
    return res.status(503).json({ error: 'db_unavailable' });
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    path: '/',
  });
  return res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const u = await hydrateUserFromDB(req.user?.id, req.user?.email);
    return res.json(u || req.user);
  } catch (e) {
    console.error('[auth] /me error', e?.message || e);
    return res.status(503).json({ error: 'db_unavailable' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    let { email, newPassword } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'invalid_email' });

    if (!newPassword) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      newPassword = Array.from({ length: 6 }, () =>
        alphabet[Math.floor(Math.random() * alphabet.length)]
      ).join('');
    }

    let updated = false;
    try {
      const hash = await bcrypt.hash(String(newPassword), 10);
      const upd = async (sql, vals) => {
        try { const r = await query(sql, vals); if (r.rowCount) updated = true; } catch {}
      };
      await upd(`UPDATE users SET pass_hash=$2        WHERE lower(email)=lower($1)`, [email, hash]);
      await upd(`UPDATE users SET password_hash=$2    WHERE lower(email)=lower($1)`, [email, hash]);
      await upd(`UPDATE users SET password=$2         WHERE lower(email)=lower($1)`, [email, String(newPassword)]);
      await upd(`UPDATE admin_users SET password_hash=$2 WHERE lower(email)=lower($1)`, [email, hash]);
      await upd(`UPDATE admins SET password=$2        WHERE lower(email)=lower($1)`, [email, String(newPassword)]);
    } catch (e) {
      console.warn('[reset-password] hashing/update skipped:', e.message);
    }

    let delivered = false;
    try {
      delivered = await sendResetMailBrevo(email, newPassword);
    } catch (e) {
      console.error('[reset-password] smtp error:', e?.code || e?.message || e);
      delivered = false;
    }

    return res.json({ ok: true, delivered, updated });
  } catch (err) {
    console.error('[reset-password] error:', err);
    return res.json({ ok: true, delivered: false, updated: false });
  }
});

export default router;
