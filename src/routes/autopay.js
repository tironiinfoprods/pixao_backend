// backend/src/routes/autopay.js
import express from "express";
import { query, getPool } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

// Helpers de Mercado Pago (SDK/tokenização feita no front)
// mpEnsureCustomer({ user, doc_number, name }) -> { customerId }
// mpSaveCard({ customerId, card_token }) -> { cardId, brand, last4 }
// mpChargeCard({ customerId, cardId, amount_cents, description, metadata }) -> { status, paymentId }
import {
  mpEnsureCustomer,
  mpSaveCard,
  mpChargeCard,
} from "../services/mercadopago.js";

const router = express.Router();

// ====== MP token (server) — aceita várias chaves de env para evitar quebra ======
const MP_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  process.env.MERCADOPAGO_ACCESS_TOKEN ||
  process.env.REACT_APP_MP_ACCESS_TOKEN ||
  null;

/* ------------------------------------------------------------------ *
 * Utils
 * ------------------------------------------------------------------ */

function parseNumbers(input) {
  // Dedup, valida (00..99) e aplica um limite de segurança no backend (20)
  const arr = Array.isArray(input)
    ? input
    : String(input || "")
        .split(/[,\s;]+/)
        .map((t) => t.trim())
        .filter(Boolean);

  const nums = [...new Set(arr.map(Number))] // dedupe
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99)
    .slice(0, 20); // limite de segurança

  // (opcional) manter ordenado para UX mais previsível
  nums.sort((a, b) => a - b);
  return nums;
}

async function getTicketPriceCents(client) {
  // tenta pegar de kv_store/app_config; fallback R$ 3,00
  try {
    const r1 = await client.query(
      `select value from public.kv_store where key in ('ticket_price_cents','price_cents') limit 1`
    );
    if (r1.rowCount) {
      const v = Number(r1.rows[0].value);
      if (Number.isFinite(v) && v > 0) return v | 0;
    }
  } catch {}
  try {
    const r2 = await client.query(
      `select price_cents from public.app_config order by id desc limit 1`
    );
    if (r2.rowCount) {
      const v = Number(r2.rows[0].price_cents);
      if (Number.isFinite(v) && v > 0) return v | 0;
    }
  } catch {}
  return 300; // fallback
}

async function isNumberFree(client, draw_id, n) {
  // livre se NÃO está em payments aprovados e NÃO está em reservas ativas/pagas
  const q = `
    with
    p as (
      select 1 from public.payments
       where draw_id=$1
         and lower(status) in ('approved','paid','pago')
         and $2 = any(numbers) limit 1
    ),
    r as (
      select 1 from public.reservations
       where draw_id=$1
         and lower(status) in ('active','pending','paid')
         and (
           $2 = any(numbers)
           or n = $2
         )
       limit 1
    )
    select
      coalesce((select 1 from p),0) as taken_pay,
      coalesce((select 1 from r),0) as taken_resv
  `;
  const r = await client.query(q, [draw_id, n]);
  return !(r.rows[0].taken_pay || r.rows[0].taken_resv);
}

/* ------------------------------------------------------------------ *
 * ME: carregar/salvar perfil
 * ------------------------------------------------------------------ */

// GET /api/me/autopay
router.get("/me/autopay", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `select ap.*, array(
         select n from public.autopay_numbers an where an.autopay_id = ap.id order by n
       ) as numbers
       from public.autopay_profiles ap
      where ap.user_id = $1
      limit 1`,
      [req.user.id]
    );
    if (!rows.length) return res.json(null);
    const p = rows[0];
    res.json({
      id: p.id,
      active: !!p.active,
      brand: p.brand || null,
      last4: p.last4 || null,
      holder_name: p.holder_name || null,
      doc_number: p.doc_number || null,
      numbers: p.numbers || [],
    });
  } catch (e) {
    console.error("[autopay] GET error:", e?.message || e);
    res.status(500).json({ error: "load_failed" });
  }
});

// **NOVO** — GET /api/autopay/claims
// Números cativos ocupados (globais) e os do usuário logado
router.get("/autopay/claims", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // todos os números com perfil ativo
    const all = await query(
      `select array(
         select distinct n
           from public.autopay_numbers an
           join public.autopay_profiles ap on ap.id = an.autopay_id
          where ap.active = true
          order by n
       ) as taken`
    );

    // números cativos do usuário logado (se tiver perfil)
    const mine = await query(
      `select array(
         select n from public.autopay_numbers an
          where an.autopay_id = (
            select id from public.autopay_profiles where user_id=$1 limit 1
          )
          order by n
       ) as mine`,
      [userId]
    );

    res.json({
      taken: all.rows?.[0]?.taken || [],
      mine: mine.rows?.[0]?.mine || [],
    });
  } catch (e) {
    console.error("[autopay/claims] error:", e?.message || e);
    res.status(500).json({ error: "claims_failed" });
  }
});

// POST /api/me/autopay
// body: { active?:bool, numbers?:[]|csv, card_token?:string, holder_name?, doc_number? }
router.post("/me/autopay", requireAuth, async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const user_id = req.user.id;
    const active =
      req.body?.active !== undefined ? !!req.body.active : true;
    const holder_name = String(req.body?.holder_name || "").slice(0, 120);
    const doc_number = String(req.body?.doc_number || "")
      .replace(/\D+/g, "")
      .slice(0, 18);
    const numbers = parseNumbers(req.body?.numbers);
    const card_token = req.body?.card_token
      ? String(req.body.card_token)
      : null;

    // Se for atualizar/salvar cartão, exigir dados mínimos do titular
    if (card_token && (!holder_name || !doc_number)) {
      return res
        .status(400)
        .json({ error: "missing_holder_or_doc" });
    }

    // Se tentará salvar cartão mas o servidor não tem MP token, avisa claramente
    if (card_token && !MP_TOKEN) {
      console.error("[autopay] missing MP_ACCESS_TOKEN on server");
      return res.status(503).json({ error: "mp_not_configured" });
    }

    await client.query("BEGIN");

    // upsert perfil
    let r = await client.query(
      `insert into public.autopay_profiles (user_id, active, holder_name, doc_number)
       values ($1,$2,$3,$4)
       on conflict (user_id) do update
         set active = excluded.active,
             holder_name = excluded.holder_name,
             doc_number = excluded.doc_number,
             updated_at = now()
       returning *`,
      [user_id, active, holder_name || null, doc_number || null]
    );
    const profile = r.rows[0];

    // atualiza números (substitui todos)
    await client.query(
      `delete from public.autopay_numbers where autopay_id=$1`,
      [profile.id]
    );
    if (numbers.length) {
      const args = numbers.map((_, i) => `($1,$${i + 2})`).join(",");
      await client.query(
        `insert into public.autopay_numbers(autopay_id, n) values ${args}`,
        [profile.id, ...numbers]
      );
    }

    // cartão (opcional) — salvar no MP e gravar ids (não logar dados sensíveis)
    let cardMeta = {
      brand: profile.brand,
      last4: profile.last4,
      mp_card_id: profile.mp_card_id,
      mp_customer_id: profile.mp_customer_id,
    };

    if (card_token) {
      const customer = await mpEnsureCustomer({
        user: req.user,
        doc_number,
        name: holder_name || req.user?.name || "Cliente",
      });

      const saved = await mpSaveCard({
        customerId: customer.customerId,
        card_token,
      });

      const up = await client.query(
        `update public.autopay_profiles
            set mp_customer_id = $2,
                mp_card_id = $3,
                brand = $4,
                last4 = $5,
                updated_at = now()
          where id=$1
          returning *`,
        [
          profile.id,
          customer.customerId,
          saved.cardId,
          saved.brand,
          saved.last4,
        ]
      );

      cardMeta = {
        brand: up.rows[0].brand,
        last4: up.rows[0].last4,
        mp_customer_id: up.rows[0].mp_customer_id,
        mp_card_id: up.rows[0].mp_card_id,
      };
    }

    await client.query("COMMIT");
    res.json({
      ok: true,
      active,
      numbers,
      card: {
        brand: cardMeta.brand || null,
        last4: cardMeta.last4 || null,
        has_card: !!cardMeta.mp_card_id,
      },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[autopay] save error:", e?.message || e);
    res.status(500).json({ error: "save_failed" });
  } finally {
    client.release();
  }
});

/* ------------------ NOVO: cancelar perfil/limpar cartão e números ------------------ */
// POST /api/me/autopay/cancel
router.post("/me/autopay/cancel", requireAuth, async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Obtém (ou cria) perfil do usuário
    const { rows } = await client.query(
      `select * from public.autopay_profiles where user_id=$1 limit 1`,
      [req.user.id]
    );

    if (!rows.length) {
      // nenhum perfil: nada a cancelar, mas respondemos ok
      await client.query("COMMIT");
      return res.json({
        ok: true,
        canceled: true,
        active: false,
        numbers: [],
        card: { has_card: false, brand: null, last4: null },
      });
    }

    const profile = rows[0];

    // limpa números
    await client.query(
      `delete from public.autopay_numbers where autopay_id=$1`,
      [profile.id]
    );

    // desativa + apaga cartão (mantém holder/doc)
    const up = await client.query(
      `update public.autopay_profiles
          set active=false,
              mp_card_id=null,
              brand=null,
              last4=null,
              updated_at=now()
        where id=$1
        returning *`,
      [profile.id]
    );

    await client.query("COMMIT");
    return res.json({
      ok: true,
      canceled: true,
      active: false,
      numbers: [],
      card: { has_card: false, brand: null, last4: null },
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[autopay/cancel] error:", e?.message || e);
    res.status(500).json({ error: "cancel_failed" });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 * ADMIN: rodar cobrança automática em um sorteio aberto
 * ------------------------------------------------------------------ */

// POST /api/admin/draws/:id/autopay-run
router.post(
  "/admin/draws/:id/autopay-run",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    // Sem token do MP não dá para cobrar
    if (!MP_TOKEN) {
      console.error("[autopay-run] missing MP_ACCESS_TOKEN on server");
      return res.status(503).json({ error: "mp_not_configured" });
    }

    const pool = await getPool();
    const client = await pool.connect();
    const draw_id = Number(req.params.id);
    if (!Number.isInteger(draw_id)) {
      client.release();
      return res.status(400).json({ error: "bad_draw_id" });
    }

    try {
      await client.query("BEGIN");

      // status do sorteio (somente abertos)
      const d = await client.query(
        `select id, status from public.draws where id=$1`,
        [draw_id]
      );
      if (!d.rowCount) throw new Error("draw_not_found");
      const st = String(d.rows[0].status || "").toLowerCase();
      if (!["open", "aberto"].includes(st)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "draw_not_open" });
      }

      // perfis ativos com cartão salvo
      const { rows: profiles } = await client.query(
        `select ap.*, array(
           select n from public.autopay_numbers an where an.autopay_id=ap.id order by n
         ) numbers
         from public.autopay_profiles ap
         where ap.active = true
           and ap.mp_customer_id is not null
           and ap.mp_card_id is not null`
      );

      const price_cents = await getTicketPriceCents(client);
      const results = [];

      for (const p of profiles) {
        const user_id = p.user_id;
        const wants = (p.numbers || [])
          .map(Number)
          .filter((n) => n >= 0 && n <= 99);

        if (!wants.length) {
          results.push({ user_id, status: "skipped", reason: "no_numbers" });
          continue;
        }

        // filtra apenas os ainda livres
        const free = [];
        for (const n of wants) {
          // eslint-disable-next-line no-await-in-loop
          const ok = await isNumberFree(client, draw_id, n);
          if (ok) free.push(n);
        }
        if (!free.length) {
          results.push({
            user_id,
            status: "skipped",
            reason: "none_available",
          });
          continue;
        }

        const amount_cents = free.length * price_cents;

        // cobra no cartão do MP
        let charge;
        try {
          // eslint-disable-next-line no-await-in-loop
          charge = await mpChargeCard({
            customerId: p.mp_customer_id,
            cardId: p.mp_card_id,
            amount_cents,
            description: `Sorteio ${draw_id} – números: ${free
              .map((n) => String(n).padStart(2, "0"))
              .join(", ")}`,
            metadata: { user_id, draw_id, numbers: free },
          });
        } catch (e) {
          // loga e segue para o próximo perfil (sem dados sensíveis)
          await client.query(
            `insert into public.autopay_runs (autopay_id,user_id,draw_id,tried_numbers,status,error)
             values ($1,$2,$3,$4,'error',$5)`,
            [p.id, user_id, draw_id, free, String(e?.message || e)]
          );
          results.push({ user_id, status: "error", error: "charge_failed" });
          continue;
        }

        if (!charge || String(charge.status).toLowerCase() !== "approved") {
          await client.query(
            `insert into public.autopay_runs (autopay_id,user_id,draw_id,tried_numbers,status,error)
             values ($1,$2,$3,$4,'error','not_approved')`,
            [p.id, user_id, draw_id, free]
          );
          results.push({ user_id, status: "error", error: "not_approved" });
          continue;
        }

        // grava payment/reservation (espelha /assign-numbers)
        const pay = await client.query(
          `insert into public.payments (user_id, draw_id, numbers, amount_cents, status, created_at)
           values ($1,$2,$3::int2[],$4,'approved', now())
           returning id`,
          [user_id, draw_id, free, amount_cents]
        );
        const resv = await client.query(
          `insert into public.reservations (id, user_id, draw_id, numbers, status, created_at, expires_at)
           values (gen_random_uuid(), $1, $2, $3::int2[], 'paid', now(), now())
           returning id`,
          [user_id, draw_id, free]
        );

        await client.query(
          `insert into public.autopay_runs (autopay_id,user_id,draw_id,tried_numbers,bought_numbers,amount_cents,status,payment_id,reservation_id)
           values ($1,$2,$3,$4,$5,$6,'ok',$7,$8)`,
          [
            p.id,
            user_id,
            draw_id,
            free,
            free,
            amount_cents,
            pay.rows[0].id,
            resv.rows[0].id,
          ]
        );

        results.push({ user_id, status: "ok", numbers: free, amount_cents });
      }

      await client.query("COMMIT");
      res.json({ ok: true, draw_id, results, price_cents });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error("[autopay-run] error:", e?.message || e);
      res.status(500).json({ error: "run_failed" });
    } finally {
      client.release();
    }
  }
);

export default router;
