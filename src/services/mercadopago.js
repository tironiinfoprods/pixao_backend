// backend/src/services/mercadopago.js
// ESM
import crypto from "node:crypto";

const MP_BASE =
  (process.env.MP_BASE_URL && process.env.MP_BASE_URL.replace(/\/+$/, "")) ||
  "https://api.mercadopago.com";

// Busca o token sempre que precisar (permite trocar env e redeploy sem cache em const)
function getAccessToken() {
  return (
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    process.env.MP_ACCESS_TOKEN ||
    process.env.REACT_APP_MP_ACCESS_TOKEN || // fallback (não recomendado)
    ""
  );
}

function ensureToken() {
  if (!getAccessToken()) {
    throw new Error(
      "MP_ACCESS_TOKEN/MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
    );
  }
}

async function mpFetch(
  method,
  path,
  body,
  extraHeaders = {},
  { timeoutMs = 15000 } = {}
) {
  ensureToken();

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${MP_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "newstore-autopay/1.0",
        ...extraHeaders,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(t);
    if (e?.name === "AbortError") {
      throw new Error(`MercadoPago ${method} ${path} timeout`);
    }
    throw e;
  }
  clearTimeout(t);

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const causeText =
      Array.isArray(json?.cause) && json.cause.length
        ? json.cause
            .map((c) => c?.description || c?.message || c?.code)
            .filter(Boolean)
            .join(" | ")
        : null;

    const msg =
      json?.message ||
      json?.error?.message ||
      json?.error ||
      `MercadoPago ${method} ${path} falhou (${res.status})${
        causeText ? `: ${causeText}` : ""
      }`;

    const err = new Error(msg);
    err.status = res.status;
    err.response = json;
    throw err;
  }

  return json;
}

function toBRL(amount_cents) {
  const cents = Math.max(0, Math.round(Number(amount_cents || 0)));
  return Number((cents / 100).toFixed(2));
}

/**
 * Garante/retorna um customer no MP (procura por email; senão cria).
 * Retorna: { customerId }
 */
export async function mpEnsureCustomer({ user, doc_number, name }) {
  ensureToken();
  const email = user?.email || undefined;

  if (email) {
    const found = await mpFetch(
      "GET",
      `/v1/customers/search?email=${encodeURIComponent(email)}`
    );
    const hit = found?.results?.[0];
    if (hit?.id) return { customerId: hit.id };
  }

  const created = await mpFetch("POST", "/v1/customers", {
    email,
    first_name: name || user?.name || "Cliente",
    description: user?.id ? `user:${user.id}` : undefined,
    identification: doc_number
      ? {
          type: String(doc_number).length > 11 ? "CNPJ" : "CPF",
          number: String(doc_number),
        }
      : undefined,
  });

  return { customerId: created.id };
}

/**
 * Salva um cartão no customer a partir de um card_token (gerado no front).
 * Retorna: { cardId, brand, last4 }
 */
export async function mpSaveCard({ customerId, card_token }) {
  const card = await mpFetch("POST", `/v1/customers/${customerId}/cards`, {
    token: card_token,
  });

  const brand =
    card?.payment_method?.id ||
    card?.payment_method?.name ||
    card?.issuer?.name ||
    null;

  const last4 = card?.last_four_digits || null;

  return { cardId: card.id, brand, last4 };
}

/**
 * Cobra usando cartão salvo:
 * 1) Cria um card_token a partir de (customer_id, card_id)
 * 2) Cria o payment com esse token
 * Retorna: { status, paymentId }
 *
 * OBS:
 *  - NÃO armazenamos CVV. Tentamos sem CVV.
 *  - Se a conta do MP exigir CVV, retornamos erro com code 'SECURITY_CODE_REQUIRED'.
 */
export async function mpChargeCard({
  customerId,
  cardId,
  amount_cents,
  description,
  metadata,
  security_code, // opcional (se o caller tiver obtido no front nesta sessão)
}) {
  // 1) token a partir do cartão salvo
  //    (se security_code vier, enviamos; senão, omitimos)
  let cardTok;
  try {
    const tokenBody = {
      customer_id: customerId,
      card_id: cardId,
    };
    if (security_code) tokenBody.security_code = String(security_code);

    cardTok = await mpFetch("POST", "/v1/card_tokens", tokenBody);
  } catch (e) {
    // Mapeia a exigência de CVV para um erro claro e tratável a montante
    const raw =
      e?.response?.cause?.map((c) => `${c?.code || ""}:${c?.description || ""}`)?.join("|") ||
      e?.message ||
      "";
    const text = String(raw).toLowerCase();
    if (text.includes("security_code") || text.includes("security_code_id")) {
      const err = new Error("mp_requires_security_code");
      err.code = "SECURITY_CODE_REQUIRED";
      err.original = e;
      throw err;
    }
    throw e;
  }

  // 2) pagamento (sem currency_id explícito para não conflitar com a conta)
  const amount = toBRL(amount_cents);
  const idempotencyKey = crypto.randomUUID();

  const pay = await mpFetch(
    "POST",
    "/v1/payments",
    {
      transaction_amount: amount,
      description: description || "AutoPay",
      token: cardTok.id,
      installments: 1,
      payer: { type: "customer", id: customerId },
      metadata: metadata || {},
      statement_descriptor: process.env.MP_STATEMENT || undefined,
      binary_mode: true,
    },
    { "X-Idempotency-Key": idempotencyKey }
  );

  return { status: pay.status, paymentId: pay.id };
}

// backend/src/services/mercadopago.js
// ... (tudo que você já tem permanece igual acima)

//
// === PIX (v1/payments) ===============================================
//
// Cria um pagamento PIX direto no MP.
// Você pode chamar com:
//  - { amount_cents }            -> valor total em centavos
//  - { unit_price, quantity }    -> valor em reais * quantidade
//
// Retorna: { id, status, qr_code, qr_code_base64, ticket_url, raw }
//
export async function createMercadoPagoPreferenceOrPix({
  title,
  amount_cents,            // em centavos (prioritário se informado)
  unit_price,              // em reais
  quantity = 1,
  metadata = {},
  payer = {},              // { email, name, identification?: { type, number } }
}) {
  ensureToken();

  // calcula o total em reais
  let totalReais;
  if (amount_cents != null) {
    totalReais = toBRL(amount_cents);
  } else {
    const up = Number(unit_price || 0);
    totalReais = Number((up * quantity).toFixed(2));
  }

  const idempotencyKey = crypto.randomUUID();

  const pay = await mpFetch(
    "POST",
    "/v1/payments",
    {
      transaction_amount: totalReais,
      description: title || "E-book",
      payment_method_id: "pix",
      installments: 1,
      metadata,
      payer: {
        email: payer.email || undefined,
        first_name: payer.name || undefined,
        identification: payer.identification || undefined, // { type, number }
      },
      // binary_mode: true, // (opcional para cartão; PIX não precisa)
    },
    { "X-Idempotency-Key": idempotencyKey }
  );

  const tx = pay?.point_of_interaction?.transaction_data || {};
  return {
    id: pay.id,
    status: pay.status,                  // geralmente "pending"
    qr_code: tx.qr_code || null,         // copia & cola
    qr_code_base64: tx.qr_code_base64 || null,
    ticket_url: tx.ticket_url || null,   // página do QR
    raw: pay,
  };
}

// export default já existente — apenas inclua a função nova:
export default {
  mpEnsureCustomer,
  mpSaveCard,
  mpChargeCard,
  createMercadoPagoPreferenceOrPix, // 👈 adicionar aqui
};



