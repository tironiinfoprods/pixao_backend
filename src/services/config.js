// src/services/config.js
import { query } from "../db.js";

/** Cria a tabela (se não existir) e injeta defaults */
export async function ensureAppConfig() {
  await query(`
    create table if not exists app_config (
      key text primary key,
      value text not null,
      updated_at timestamptz default now()
    )
  `);

  const defaults = [
    ["ticket_price_cents", String(process.env.PRICE_CENTS ?? "5500")],
    ["max_numbers_per_selection", "5"],
    ["banner_title", ""],
  ];

  for (const [k, v] of defaults) {
    await query(
      `insert into app_config(key,value) values($1,$2)
       on conflict (key) do nothing`,
      [k, v]
    );
  }
}

/** helpers genéricos */
async function getConfigValue(key) {
  const r = await query(`select value from app_config where key=$1`, [key]);
  return r.rows?.[0]?.value ?? null;
}
async function setConfigValue(key, value) {
  await query(
    `insert into app_config(key,value,updated_at)
     values($1,$2,now())
     on conflict(key) do update set value=excluded.value, updated_at=now()`,
    [key, String(value ?? "")]
  );
}

/** price */
export async function getTicketPriceCents() {
  const v = await getConfigValue("ticket_price_cents");
  const n = Number(v ?? process.env.PRICE_CENTS ?? 5500);
  return Number.isFinite(n) ? n : 5500;
}
export async function setTicketPriceCents(v) {
  const n = Math.max(0, Math.floor(Number(v || 0)));
  await setConfigValue("ticket_price_cents", String(n));
  return n;
}

/** banner title */
export async function getBannerTitle() {
  return (await getConfigValue("banner_title")) || "";
}
export async function setBannerTitle(title) {
  await setConfigValue("banner_title", String(title ?? ""));
}

/** max numbers per selection */
export async function getMaxNumbersPerSelection() {
  const v = await getConfigValue("max_numbers_per_selection");
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 5;
}
export async function setMaxNumbersPerSelection(n) {
  const val = Math.max(1, Math.floor(Number(n || 1)));
  await setConfigValue("max_numbers_per_selection", String(val));
  return val;
}
