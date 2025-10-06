// src/db/pg.js
// Pool pg para Supabase (pooler/direto) com SSL no-verify (Render/Supabase),
// rotação IPv4, retries e reconexão. Prioriza DATABASE_URL.

import pg from "pg";
import dns from "dns";
import { URL as NodeURL } from "url";

const env = process.env;

// --- Utils
const stripQuotes = (s) => (s ? String(s).trim().replace(/^['"]+|['"]+$/g, "") : s);

// ===== 1) Coleta URLs (DATABASE_URL primeiro)
const dbUrlPrimary   = stripQuotes(env.DATABASE_URL || "");
const directURL      = stripQuotes(env.POSTGRES_URL || "");
const prismaURL      = stripQuotes(env.POSTGRES_PRISMA_URL || "");
const nonPoolingURL  = stripQuotes(env.POSTGRES_URL_NON_POOLING || "");

const ordered = [];
if (dbUrlPrimary)  ordered.push(dbUrlPrimary);   // << prioridade
if (directURL)     ordered.push(directURL);
if (prismaURL)     ordered.push(prismaURL);
if (nonPoolingURL) ordered.push(nonPoolingURL);

const urlsRaw = ordered.map(normalizeSafe).filter(Boolean);

// Remove duplicadas preservando ordem
const seen = new Set();
const urls = urlsRaw.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

if (urls.length === 0) {
  console.error("[pg] Nenhuma DATABASE_URL válida encontrada nas ENVs");
}

// ===== normalization helper
function normalizeSafe(url) {
  if (!url) return null;
  try {
    url = stripQuotes(url);
    const u = new NodeURL(url);

    // Ajustes de porta padrão Supabase
    if (/pooler\.supabase\.com$/i.test(u.hostname)) u.port = "6543";
    if (/\.supabase\.co$/i.test(u.hostname) && !u.port) u.port = "5432";

    // >>> Importante: REMOVER sslmode da URL (vamos configurar SSL no objeto)
    if (/[?&]sslmode=/i.test(u.search)) {
      const params = new URLSearchParams(u.search.replace(/^\?/, ""));
      params.delete("sslmode");
      const rest = params.toString();
      u.search = rest ? `?${rest}` : "";
    }

    return u.toString();
  } catch (err) {
    console.warn("[pg] normalizeSafe falhou:", url, err?.message);
    return url;
  }
}

// ===== 2) SSL helper (força no-verify; resolve SELF_SIGNED_CERT_IN_CHAIN)
function sslFor(url, sniHost) {
  try {
    const u = new NodeURL(url);
    const host = u.hostname;
    // Mantém SNI correto para pooler (hostname original), mas desabilita verificação
    return { rejectUnauthorized: false, servername: sniHost || host };
  } catch {
    return { rejectUnauthorized: false, servername: sniHost };
  }
}

// ===== 3) DNS helpers (IPv4)
const dnp = dns.promises;

async function resolveAllIPv4(host) {
  try {
    const addrs = await dnp.resolve4(host);
    return Array.isArray(addrs) && addrs.length ? addrs : [];
  } catch {
    try {
      const { address } = await dnp.lookup(host, { family: 4, hints: dns.ADDRCONFIG });
      return address ? [address] : [];
    } catch {
      return [];
    }
  }
}

async function toIPv4Candidates(url) {
  try {
    const u = new NodeURL(url);
    const host = u.hostname;

    // Para hosts fora do Supabase, não troca por IP
    if (!/\.(supabase\.co|supabase\.com)$/i.test(host)) {
      return [{ url, sni: undefined }];
    }

    const ips = await resolveAllIPv4(host);
    if (!ips.length) return [{ url, sni: host }];

    return ips.map((ip) => {
      const clone = new NodeURL(url);
      clone.hostname = ip;
      return { url: clone.toString(), sni: host };
    });
  } catch {
    return [{ url, sni: undefined }];
  }
}

// ===== 4) Config builder
function cfg(url, sni) {
  return {
    connectionString: url,
    // >>> SSL configurado no objeto (ignora verificação do cert)
    ssl: sslFor(url, sni),
    lookup: (hostname, _opts, cb) =>
      dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
    max: Number(env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

// ===== 5) State
let pool = null;
let reconnectTimer = null;

function safe(url) {
  return String(url).replace(/:[^@]+@/, "://***:***@");
}

const TRANSIENT_CODES = new Set([
  "57P01", "57P02", "57P03", "08006",
  "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "ENETUNREACH", "ECONNREFUSED",
]);

function isTransient(err) {
  const code = String(err.code || err.errno || "").toUpperCase();
  const msg = String(err.message || "");
  return TRANSIENT_CODES.has(code) || /Connection terminated|read ECONNRESET/i.test(msg);
}

// ===== 6) Connection logic
async function connectOnce(url) {
  const candidates = await toIPv4Candidates(url);
  let lastErr = null;

  for (const c of candidates) {
    const p = new pg.Pool(cfg(c.url, c.sni));
    try {
      await p.query("SELECT 1");
      console.log("[pg] conectado em", safe(c.url));
      p.on("error", (e) => {
        console.error("[pg] pool error", e.code || e.message || e);
        pool = null;
        scheduleReconnect();
      });
      return p;
    } catch (e) {
      lastErr = e;
      console.log("[pg] falha em", safe(c.url), "->", e.code || e.errno || e.message);
      await p.end().catch(() => {});
      continue;
    }
  }
  throw lastErr || new Error("Todos os candidatos IPv4 falharam");
}

async function connectWithRetry(urlList) {
  const PER_URL_TRIES = 5;
  const BASE_DELAY = 500;
  let lastErr = null;

  for (const url of urlList) {
    for (let i = 0; i < PER_URL_TRIES; i++) {
      try {
        return await connectOnce(url);
      } catch (e) {
        lastErr = e;
        if (i < PER_URL_TRIES - 1 && isTransient(e)) {
          const delay = BASE_DELAY * Math.pow(2, i);
          console.warn("[pg] erro transitório, retry", i + 1, "de", PER_URL_TRIES, "em", delay, "ms");
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error("Todas as URLs de banco falharam");
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (pool) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      return;
    }
    try {
      console.warn("[pg] tentando reconectar em background...");
      pool = await connectWithRetry(urls);
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      console.log("[pg] reconectado com sucesso");
    } catch (e) {
      console.warn("[pg] reconexão falhou:", e.code || e.message);
    }
  }, 5_000);
}

export async function getPool() {
  if (!pool) {
    console.log("[pg] tentando conexão com URLs:", JSON.stringify(urls.map(safe), null, 2));
    try {
      pool = await connectWithRetry(urls);
    } catch (e) {
      console.error("[pg] conexão inicial falhou:", e.code || e.message);
      scheduleReconnect();
      throw e;
    }
  }
  return pool;
}

export async function query(text, params) {
  try {
    const p = await getPool();
    return await p.query(text, params);
  } catch (e) {
    if (isTransient(e)) {
      console.warn("[pg] erro transitório em query, recriando pool...");
      pool = null;
      scheduleReconnect();
      const p = await getPool();
      return await p.query(text, params);
    }
    throw e;
  }
}

export async function endPool() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  if (pool) {
    try {
      await pool.end();
      console.log("[pg] pool finalizado");
    } catch (e) {
      console.warn("[pg] falha ao finalizar pool:", e.code || e.message);
    }
    pool = null;
  }
}

// Cleanup on exit
process.on("exit", () => {
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
});
process.on("SIGINT", () => {
  endPool().finally(() => process.exit(0));
}); 