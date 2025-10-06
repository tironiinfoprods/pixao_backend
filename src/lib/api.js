// src/lib/api.js
// Util de API para o frontend (React)

// 1) Leia UMA variável de base. Evite manter chaves duplicadas.
//    (Se alguém esquecer, ainda aceitamos REACT_APP_API_BASE para compat.)
const RAW =
  process.env.REACT_APP_API_BASE_URL ||
  process.env.REACT_APP_API_BASE ||
  "";

// 2) Normaliza a raiz (sem barra final)
const ROOT = String(RAW || "").replace(/\/+$/, "");

// 3) Garante que termina com /api exatamente uma vez
const API_BASE = !ROOT
  ? "/api"
  : /\/api$/i.test(ROOT)
  ? ROOT
  : ROOT + "/api";

// 4) Junta caminho, removendo /api duplicado no início do path
export const apiJoin = (path) => {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (API_BASE.endsWith("/api") && p.startsWith("/api/")) p = p.slice(4); // tira "/api" extra
  return `${API_BASE}${p}`;
};

/* ---------- token helpers ---------- */
const TOKEN_KEY = "ns_auth_token";
const COMPAT_KEYS = ["token", "access_token"];

export const getStoredToken = () =>
  (
    localStorage.getItem(TOKEN_KEY) ||
    sessionStorage.getItem(TOKEN_KEY) ||
    localStorage.getItem(COMPAT_KEYS[0]) ||
    localStorage.getItem(COMPAT_KEYS[1]) ||
    sessionStorage.getItem(COMPAT_KEYS[0]) ||
    sessionStorage.getItem(COMPAT_KEYS[1]) ||
    ""
  )
    .toString()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");

export const authHeaders = () => {
  const t = getStoredToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

/* ---------- HTTP helpers (robustos a HTML) ---------- */
async function request(pathOrUrl, opts = {}) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : apiJoin(pathOrUrl);

  const r = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
      ...authHeaders(), // sempre tenta mandar o token se existir
    },
    credentials: "omit", // usamos Authorization, não cookie
    body: opts.body
      ? typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body)
      : undefined,
  });

  // Trata status não-2xx com a melhor mensagem possível
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = await r.json();
      if (j?.error) msg = `${j.error}:${r.status}`;
    } catch {
      // se não for JSON, tenta texto
      try { msg = `${await r.text()} (${r.status})`; } catch {}
    }
    throw new Error(msg);
  }

  // Conteúdo esperado: JSON. Se vier HTML/texto, evitamos o "Unexpected token '<'".
  const ct = String(r.headers.get("content-type") || "").toLowerCase();

  // 204/sem corpo
  if (r.status === 204 || Number(r.headers.get("content-length") || 0) === 0) {
    return null;
  }

  if (ct.includes("application/json")) {
    return r.json();
  }

  // Não é JSON: loga um preview e erra de forma controlada
  const text = await r.text().catch(() => "");
  console.warn("[api] expected JSON from", url, "but got:", text.slice(0, 160));
  throw new Error("bad_json");
}

export const getJSON = (path, opts = {}) => request(path, { ...opts, method: "GET" });
export const postJSON = (path, body, opts = {}) => request(path, { ...opts, method: "POST", body });
export const putJSON = (path, body, opts = {}) => request(path, { ...opts, method: "PUT", body });
export const delJSON = (path, opts = {}) => request(path, { ...opts, method: "DELETE" });
