// src/lib/app_config.js
import { query } from "../db.js";

/**
 * Cria a tabela app_config (se não existir) e injeta o valor padrão
 * para o preço do ticket (em centavos).
 */
export async function ensureAppConfig() {
  await query(`
    create table if not exists app_config (
      key text primary key,
      value text not null,
      updated_at timestamptz default now()
    )
  `);
  const def = String(process.env.PRICE_CENTS ?? "5500");
  await query(
    `insert into app_config(key,value)
     values('ticket_price_cents', $1)
     on conflict (key) do nothing`,
    [def]
  );
}

// cache simples (10s) para reduzir round-trips ao DB
let cache = { v: null, ts: 0 };

export async function getTicketPriceCents() {
  if (Date.now() - cache.ts < 10_000 && Number.isFinite(cache.v)) return cache.v;
  const r = await query(
    `select value from app_config where key='ticket_price_cents'`
  );
  const n = Number(r.rows?.[0]?.value ?? process.env.PRICE_CENTS ?? 5500);
  cache = { v: n, ts: Date.now() };
  return n;
}

export async function setTicketPriceCents(v) {
  const n = Math.max(0, Math.floor(Number(v || 0)));
  await query(
    `insert into app_config(key,value,updated_at)
       values('ticket_price_cents', $1, now())
     on conflict (key) do update
       set value = excluded.value,
           updated_at = now()`,
    [String(n)]
  );
  cache = { v: n, ts: Date.now() };
  return n;
}
