// backend/src/routes/payments.js
import { Router } from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { getTicketPriceCents } from '../services/config.js';
import { createMercadoPagoPreferenceOrPix } from '../services/mercadopago.js';

const router = Router();

// Aceita MP_ACCESS_TOKEN (backend) ou REACT_APP_MP_ACCESS_TOKEN (Render)
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || process.env.REACT_APP_MP_ACCESS_TOKEN,
});
const mpPayment = new Payment(mpClient);

const PIX_EXP_MIN = Math.max(
  30,
  Number(process.env.PIX_EXP_MIN || process.env.PIX_EXP_MINUTES || 30)
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function finalizeDrawIfComplete(drawId) {
  await query('BEGIN');
  try {
    await query('SELECT pg_advisory_xact_lock(911001)');

    const cur = await query(
      `SELECT id, status, closed_at
         FROM draws
        WHERE id = $1
        FOR UPDATE`,
      [drawId]
    );
    if (!cur.rows.length) {
      await query('ROLLBACK');
      return;
    }

    const cnt = await query(
      `SELECT COUNT(*)::int AS sold
         FROM numbers
        WHERE draw_id = $1 AND status = 'sold'`,
      [drawId]
    );
    const sold = cnt.rows[0]?.sold || 0;

    if (sold === 100) {
      await query(
        `UPDATE draws
            SET status = 'closed',
                closed_at = COALESCE(closed_at, NOW())
          WHERE id = $1`,
        [drawId]
      );

      // Removido: criação automática de um "draw aberto global".
      // O próximo draw deve ser criado pelo fluxo específico do infoproduto
      // (ex.: /api/infoproducts/:id/ensure-open-draw).
    }

    await query('COMMIT');
  } catch (e) {
    try { await query('ROLLBACK'); } catch {}
    console.error('[finalizeDrawIfComplete] error:', e);
  }
}

async function settleApprovedPayment(id, drawId, numbers) {
  await query(
    `UPDATE numbers
        SET status = 'sold',
            reservation_id = NULL
      WHERE draw_id = $1
        AND n = ANY($2)`,
    [drawId, numbers]
  );

  await query(
    `UPDATE reservations
        SET status = 'paid'
      WHERE payment_id = $1`,
    [id]
  );
}

/* ============================================================================
   >>> ADIÇÃO: Reconciliação automática de PIX pendentes <<<
   - Throttle por tempo (para não sobrecarregar)
   - Varrendo apenas pagamentos com draw_id (reservas de números)
   - Atualiza payments.status / numbers / reservations e finaliza draw
   - Disparo oportunista em todas as rotas deste router (router.use)
   - Opcional: timer por intervalo (AUTO_RECONCILE_INTERVAL_MS)
   ========================================================================== */

const RECONCILE_MIN_INTERVAL_MS   = Number(process.env.RECONCILE_MIN_INTERVAL_MS || 45000); // 45s
const RECONCILE_LOOKBACK_MINUTES  = Number(process.env.RECONCILE_LOOKBACK_MINUTES || 1440); // 24h
const RECONCILE_BATCH_MAX         = Number(process.env.RECONCILE_BATCH_MAX || 25);
const AUTO_RECONCILE_INTERVAL_MS  = Number(process.env.AUTO_RECONCILE_INTERVAL_MS || 0);   // 0 = desliga

let _reconLastAt = 0;
let _reconInFlight = false;

/** Exportado para uso externo opcional (ex.: outro middleware). */
export async function kickReconcilePendingPayments(force = false) {
  const now = Date.now();
  if (!force) {
    if (_reconInFlight) return { skipped: true, reason: 'in_flight' };
    if (now - _reconLastAt < RECONCILE_MIN_INTERVAL_MS) return { skipped: true, reason: 'throttled' };
  }
  _reconInFlight = true;
  _reconLastAt = now;

  try {
    const { rows } = await query(
      `SELECT id
         FROM payments
        WHERE draw_id IS NOT NULL
          AND lower(status) NOT IN ('approved','paid','pago')
          AND COALESCE(created_at, now()) >= NOW() - ($1::int || ' minutes')::interval
        ORDER BY created_at DESC
        LIMIT $2`,
      [RECONCILE_LOOKBACK_MINUTES, RECONCILE_BATCH_MAX]
    );

    let scanned = rows.length, updated = 0, approved = 0, failed = 0;

    for (const { id } of rows) {
      try {
        const resp = await mpPayment.get({ id: String(id) });
        const body = resp?.body || resp;
        const st = String(body?.status || '').toLowerCase();

        await query(
          `UPDATE payments
              SET status = $2,
                  paid_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE paid_at END
            WHERE id = $1`,
          [id, st]
        );
        updated++;

        if (st === 'approved') {
          const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
          if (pr.rows.length) {
            const { draw_id, numbers } = pr.rows[0];
            await settleApprovedPayment(id, draw_id, numbers);
            await finalizeDrawIfComplete(draw_id);
            approved++;
          }
        }
      } catch (e) {
        failed++;
        console.warn('[payments:auto-reconcile] error for', id, e?.message || e);
      }
    }

    return { scanned, updated, approved, failed };
  } catch (e) {
    console.warn('[payments:auto-reconcile] fatal:', e?.message || e);
    return { error: true };
  } finally {
    _reconInFlight = false;
  }
}

// dispara reconciliação em segundo plano a cada hit neste router
router.use((req, res, next) => {
  if (process.env.AUTO_RECONCILE_ON_HIT !== 'false') {
    kickReconcilePendingPayments().catch((e) =>
      console.warn('[payments:auto-reconcile on hit]', e?.message || e)
    );
  }
  next();
});

// timer opcional por intervalo (desligado por padrão)
if (AUTO_RECONCILE_INTERVAL_MS > 0) {
  const t = setInterval(() => {
    kickReconcilePendingPayments().catch((e) =>
      console.warn('[payments:auto-reconcile timer]', e?.message || e)
    );
  }, AUTO_RECONCILE_INTERVAL_MS);
  // evitar manter o processo vivo só por causa do timer
  if (typeof t.unref === 'function') t.unref();
}
/* ============================ FIM DA ADIÇÃO ============================ */

// -----------------------------------------------------------------------------
// Rotas
// -----------------------------------------------------------------------------

/**
 * POST /api/payments/pix
 * Body: { reservationId }
 * Auth: Bearer
 */
router.post('/pix', requireAuth, async (req, res) => {
  console.log('[payments/pix] user=', req.user?.id, 'body=', req.body);
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: 'missing_reservation' });
    }

    await query(
      `UPDATE reservations
          SET user_id = $2
        WHERE id = $1
          AND user_id IS NULL`,
      [reservationId, req.user.id]
    );

    const r = await query(
      `SELECT r.id, r.user_id, r.draw_id, r.numbers, r.status, r.expires_at,
              u.email AS user_email, u.name AS user_name
         FROM reservations r
    LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = $1`,
      [reservationId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'reservation_not_found' });

    const rs = r.rows[0];

    if (rs.status !== 'active') return res.status(400).json({ error: 'reservation_not_active' });
    if (new Date(rs.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'reservation_expired' });
    }

    const priceCents = await getTicketPriceCents();
    const amount = Number(((rs.numbers.length * priceCents) / 100).toFixed(2));

    const description = `Sorteio New Store - números ${rs.numbers
      .map((n) => n.toString().padStart(2, '0'))
      .join(', ')}`;

    const baseUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const notification_url = `${baseUrl}/api/payments/webhook`;

    const payerEmail = rs.user_email || req.user?.email || 'comprador@example.com';

    const mpResp = await mpPayment.create({
      body: {
        transaction_amount: amount,
        description,
        payment_method_id: 'pix',
        payer: { email: payerEmail },
        external_reference: String(reservationId),
        notification_url,
        date_of_expiration: new Date(Date.now() + PIX_EXP_MIN * 60 * 1000).toISOString()
      },
      requestOptions: { idempotencyKey: uuidv4() },
    });

    const body = mpResp?.body || mpResp;
    const { id, status, point_of_interaction } = body || {};
    const td = point_of_interaction?.transaction_data || {};

    let { qr_code, qr_code_base64 } = td;
    if (typeof qr_code_base64 === 'string') qr_code_base64 = qr_code_base64.replace(/\s+/g, '');
    if (typeof qr_code === 'string') qr_code = qr_code.trim();

    await query(
      `INSERT INTO payments (id, user_id, draw_id, numbers, amount_cents, status, qr_code, qr_code_base64)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             qr_code = COALESCE(EXCLUDED.qr_code, payments.qr_code),
             qr_code_base64 = COALESCE(EXCLUDED.qr_code_base64, payments.qr_code_base64)`,
      [
        String(id),
        rs.user_id || req.user.id,
        rs.draw_id,
        rs.numbers,
        rs.numbers.length * priceCents,
        status,
        qr_code || null,
        qr_code_base64 || null,
      ]
    );

    await query(`UPDATE reservations SET payment_id = $2 WHERE id = $1`, [reservationId, String(id)]);

    return res.json({ paymentId: String(id), status, qr_code, qr_code_base64 });
  } catch (e) {
    console.error('[pix] error:', e);
    return res.status(500).json({ error: 'pix_failed' });
  }
});

/**
 * GET /api/payments/:id/status
 * Auth: Bearer
 */
router.get('/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const resp = await mpPayment.get({ id: String(id) });
    const body = resp?.body || resp;

    await query(`UPDATE payments SET status = $2 WHERE id = $1`, [id, body.status]);

    if (String(body.status).toLowerCase() === 'approved') {
      const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
      if (pr.rows.length) {
        const { draw_id, numbers } = pr.rows[0];

        await settleApprovedPayment(id, draw_id, numbers);
        await finalizeDrawIfComplete(draw_id);
      }
    }

    return res.json({ id, status: body.status });
  } catch (e) {
    console.error('[status] error:', e);
    return res.status(500).json({ error: 'status_failed' });
  }
});

/**
 * POST /api/payments/webhook
 * Body: evento do Mercado Pago
 */
router.post('/webhook', async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query?.id || req.body?.id;
    const type = req.body?.type || req.query?.type;

    if (type && type !== 'payment') return res.sendStatus(200);
    if (!paymentId) return res.sendStatus(200);

    const resp = await mpPayment.get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body.id);
    const status = body.status;

    await query(
      `UPDATE payments
          SET status = $2,
              paid_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE paid_at END
        WHERE id = $1`,
      [id, status]
    );

    if (String(status).toLowerCase() === 'approved') {
      const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
      if (pr.rows.length) {
        const { draw_id, numbers } = pr.rows[0];

        await settleApprovedPayment(id, draw_id, numbers);
        await finalizeDrawIfComplete(draw_id);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] error:', e);
    return res.sendStatus(200);
  }
});

// === LISTA MEUS PAGAMENTOS (para a conta)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id,
              user_id,
              draw_id,
              numbers,
              amount_cents,
              status,
              created_at,
              paid_at
         FROM payments
        WHERE user_id = $1
        ORDER BY COALESCE(paid_at, created_at) ASC`,
      [req.user.id]
    );
    return res.json({ payments: r.rows || [] });
  } catch (e) {
    console.error('[payments/me] error:', e);
    return res.status(500).json({ error: 'list_failed' });
  }
});

/* ============================================================================
   NOVOS ENDPOINTS
   ========================================================================== */

/**
 * POST /api/payments/reconcile
 * Body: { since?: number }  // minutos a varrer (default 1440 = 24h)
 */
router.post('/reconcile', requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(5, Number(req.body?.since ?? req.body?.minutes ?? 1440));
    const { rows } = await query(
      `SELECT id
         FROM payments
        WHERE lower(status) NOT IN ('approved','paid','pago')
          AND COALESCE(created_at, now()) >= NOW() - ($1::int || ' minutes')::interval`,
      [minutes]
    );

    let scanned = rows.length, updated = 0, approved = 0, failed = 0;

    for (const { id } of rows) {
      try {
        const resp = await mpPayment.get({ id: String(id) });
        const body = resp?.body || resp;
        const st = String(body?.status || '').toLowerCase();

        await query(
          `UPDATE payments
              SET status = $2,
                  paid_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE paid_at END
            WHERE id = $1`,
          [id, st]
        );
        updated++;

        if (st === 'approved') {
          const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
          if (pr.rows.length) {
            const { draw_id, numbers } = pr.rows[0];
            await settleApprovedPayment(id, draw_id, numbers);
            await finalizeDrawIfComplete(draw_id);
            approved++;
          }
        }
      } catch (e) {
        failed++;
        console.warn('[reconcile] error for id', id, e?.message || e);
      }
    }

    return res.json({ scanned, updated, approved, failed });
  } catch (e) {
    console.error('[reconcile] fatal error:', e);
    return res.status(500).json({ error: 'reconcile_failed' });
  }
});

/**
 * POST /api/payments/webhook/replay
 * Body: { id: string }  // paymentId
 */
router.post('/webhook/replay', requireAuth, async (req, res) => {
  try {
    const paymentId = req.body?.id || req.body?.paymentId;
    if (!paymentId) return res.status(400).json({ error: 'missing_id' });

    const resp = await mpPayment.get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body?.id || paymentId);
    const status = String(body?.status || '').toLowerCase();

    await query(
      `UPDATE payments
          SET status = $2,
              paid_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE paid_at END
        WHERE id = $1`,
      [id, status]
    );

    if (status === 'approved') {
      const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
      if (pr.rows.length) {
        const { draw_id, numbers } = pr.rows[0];
        await settleApprovedPayment(id, draw_id, numbers);
        await finalizeDrawIfComplete(draw_id);
      }
    }

    return res.json({ id, status });
  } catch (e) {
    console.error('[webhook/replay] error:', e);
    return res.status(500).json({ error: 'replay_failed' });
  }
});

/**
 * POST /api/payments/infoproduct
 * Body: { infoproduct_id?: number, infoproduct_sku?: string }
 * Auth: Bearer  (exige usuário logado para termos um payer_email válido)
 */
router.post('/infoproduct', requireAuth, async (req, res) => {
  try {
    const { infoproduct_id, infoproduct_sku } = req.body || {};
    if (!infoproduct_id && !infoproduct_sku) {
      return res.status(400).json({ error: 'missing_infoproduct' });
    }

    // carrega o e-book (traga title/sku para metadata)
    const val = infoproduct_id || String(infoproduct_sku);
    const { rows } = await query(
      `
      SELECT id, sku, title, price_cents
        FROM infoproducts
       WHERE ${infoproduct_id ? 'id = $1' : 'LOWER(sku)=LOWER($1)'}
         AND active = true
       LIMIT 1
      `,
      [val]
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'infoproduct_not_found' });

    // dados do pagador (obrigatório: login garante e-mail)
    const payerEmail = req.user?.email;
    const payerName  = req.user?.name  || undefined;
    if (!payerEmail) return res.status(401).json({ error: 'unauthorized' });

    // cria pagamento PIX no Mercado Pago
    const mpPix = await createMercadoPagoPreferenceOrPix({
      title: p.title || 'E-book',
      amount_cents: p.price_cents,
      metadata: {
        kind: 'infoproduct',
        infoproduct_id: p.id,
        sku: p.sku || null,
        user_id: req.user?.id || null,
      },
      payer: {
        email: payerEmail,
        name: payerName,
      },
    });

    const paymentId = String(mpPix.id);
    const status    = String(mpPix.status || 'pending');

    await query(
      `
      INSERT INTO payments (id, user_id, draw_id, numbers, amount_cents, status, qr_code, qr_code_base64, created_at)
      VALUES ($1,  $2,      NULL,   '{}'::smallint[], $3,           $4,     $5,      $6,              NOW())
      ON CONFLICT (id) DO UPDATE
        SET status = EXCLUDED.status,
            qr_code = COALESCE(EXCLUDED.qr_code, payments.qr_code),
            qr_code_base64 = COALESCE(EXCLUDED.qr_code_base64, payments.qr_code_base64)
      `,
      [
        paymentId,
        req.user?.id || null,
        p.price_cents,
        status,
        mpPix.qr_code || null,
        mpPix.qr_code_base64 || null,
      ]
    );

    return res.json({
      paymentId,
      amount_cents: p.price_cents,
      status,
      qr_code: mpPix.qr_code,
      qr_code_base64: mpPix.qr_code_base64,
      ticket_url: mpPix.ticket_url || null,
    });
  } catch (e) {
    console.error('[payments/infoproduct]', e);
    return res.status(500).json({ error: 'create_infoproduct_payment_failed' });
  }
});

export default router;
