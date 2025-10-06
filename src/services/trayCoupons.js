// src/services/trayCoupons.js
const API = (process.env.TRAY_API_ADDRESS || 'https://www.newstorerj.com.br/web_api').replace(/\/+$/,'');
const CK  = process.env.TRAY_CONSUMER_KEY || '';
const CS  = process.env.TRAY_CONSUMER_SECRET || '';
const CODE = process.env.TRAY_CODE || '';

async function trayAuth() {
  const body = new URLSearchParams({
    consumer_key: CK,
    consumer_secret: CS,
    code: CODE,
  });
  const r = await fetch(`${API}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) throw new Error('tray_auth_failed');
  return j.access_token;
}

/**
 * Cria ou atualiza um cupom na Tray
 * @param {object} p
 * @param {string} p.code - código do cupom (ex.: NSU-0003-XH)
 * @param {number} p.value_cents - valor em centavos do desconto
 * @param {string|number} [p.coupon_id] - id do cupom na Tray (se já existir)
 */
export async function upsertTrayCoupon({ code, value_cents = 0, coupon_id }) {
  const token = await trayAuth();
  const value = (Number(value_cents) / 100).toFixed(2); // "10.00"

  const payload = new URLSearchParams();
  payload.append('DiscountCoupon[code]', code);
  payload.append('DiscountCoupon[description]', `Cupom New Store - ${code}`);
  payload.append('DiscountCoupon[value]', value);
  payload.append('DiscountCoupon[type]', '$');         // desconto em R$
  // Demais campos são opcionais, manter simples.

  const path   = coupon_id ? `/discount_coupons/${coupon_id}` : `/discount_coupons`;
  const method = coupon_id ? 'PUT' : 'POST';

  const r = await fetch(`${API}${path}?access_token=${encodeURIComponent(token)}`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload,
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Ajuda no debug
    console.error('[tray.upsert] fail', r.status, j);
    throw new Error('tray_coupon_upsert_failed');
  }

  const dc = j?.DiscountCoupon || {};
  return {
    id: dc.id || coupon_id,
    value_cents: Math.round(parseFloat(dc.value || value) * 100),
  };
}
