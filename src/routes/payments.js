// src/routes/payments.js
import { Router } from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { getTicketPriceCents } from '../services/config.js';

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

/**
 * Fecha o draw se tiver 100 vendidos e cria um novo se não existir outro 'open'.
 * Tudo dentro de TRANSAÇÃO + ADVISORY LOCK para evitar condições de corrida.
 */
async function finalizeDrawIfComplete(drawId) {
  // Inicia transação e trava seção crítica
  await query('BEGIN');
  try {
    // trava global simples (escopo transação)
    await query('SELECT pg_advisory_xact_lock(911001)');

    // Trava a linha do draw e revalida status
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

    // Reconta vendidos sob a mesma transação
    const cnt = await query(
      `SELECT COUNT(*)::int AS sold
         FROM numbers
        WHERE draw_id = $1 AND status = 'sold'`,
      [drawId]
    );
    const sold = cnt.rows[0]?.sold || 0;

    if (sold === 100) {
      // Fecha (idempotente)
      await query(
        `UPDATE draws
            SET status = 'closed',
                closed_at = COALESCE(closed_at, NOW())
          WHERE id = $1`,
        [drawId]
      );

      // Abre novo SOMENTE se não existir outro aberto
      const ins = await query(
        `WITH chk AS (
           SELECT 1 FROM draws WHERE status = 'open' LIMIT 1
         )
         INSERT INTO draws (status)
         SELECT 'open'
         WHERE NOT EXISTS (SELECT 1 FROM chk)
         RETURNING id`
      );

      const newId = ins.rows[0]?.id;
      if (newId) {
        // Popula 0..99
        await query(
          `INSERT INTO numbers (draw_id, n, status)
           SELECT $1, gs, 'available'
             FROM generate_series(0, 99) AS gs`,
          [newId]
        );
      }
    }

    await query('COMMIT');
  } catch (e) {
    try { await query('ROLLBACK'); } catch {}
    // Loga e segue; idempotência garante consistência em nova tentativa
    console.error('[finalizeDrawIfComplete] error:', e);
  }
}

/**
 * Marca números como vendidos para um pagamento aprovado
 * e marca a reserva (se houver) como 'paid'.
 */
async function settleApprovedPayment(id, drawId, numbers) {
  // marca números como vendidos
  await query(
    `UPDATE numbers
        SET status = 'sold',
            reservation_id = NULL
      WHERE draw_id = $1
        AND n = ANY($2)`,
    [drawId, numbers]
  );

  // marca reserva como paga (idempotente)
  await query(
    `UPDATE reservations
        SET status = 'paid'
      WHERE payment_id = $1`,
    [id]
  );
}

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

    // Corrige reservas antigas sem user_id (anexa ao usuário atual)
    await query(
      `UPDATE reservations
          SET user_id = $2
        WHERE id = $1
          AND user_id IS NULL`,
      [reservationId, req.user.id]
    );

    // Carrega a reserva + (opcional) usuário
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

    // Valor (preço * quantidade) — vindo do banco
    const priceCents = await getTicketPriceCents();
    const amount = Number(((rs.numbers.length * priceCents) / 100).toFixed(2));

    // Descrição e webhook
    const description = `Sorteio New Store - números ${rs.numbers
      .map((n) => n.toString().padStart(2, '0'))
      .join(', ')}`;

    const baseUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const notification_url = `${baseUrl}/api/payments/webhook`;

    // E-mail do pagador
    const payerEmail = rs.user_email || req.user?.email || 'comprador@example.com';

    // Cria pagamento PIX no Mercado Pago (idempotente)
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

    // Normaliza QR/copia-e-cola
    let { qr_code, qr_code_base64 } = td;
    if (typeof qr_code_base64 === 'string') qr_code_base64 = qr_code_base64.replace(/\s+/g, '');
    if (typeof qr_code === 'string') qr_code = qr_code.trim();

    // Persiste o pagamento
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

    // Amarra a reserva ao pagamento (status segue 'active' até aprovar)
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

    // Sempre 200 para o MP não reenfileirar indefinidamente
    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] error:', e);
    return res.sendStatus(200);
  }
});

// === LISTA MEUS PAGAMENTOS (para a conta) ===
// GET /api/payments/me  -> { payments: [...] }
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
   NOVOS ENDPOINTS — adicionados sem alterar os existentes
   ========================================================================== */

/**
 * POST /api/payments/reconcile
 * Body: { since?: number }  // minutos a varrer (default 1440 = 24h)
 * Varre pagamentos não aprovados recentes, consulta o MP e assenta se aprovado.
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
 * Reexecuta a lógica do webhook para um pagamento específico.
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

// POST /api/payments/infoproduct
// body: { infoproduct_id?: number, infoproduct_sku?: string }
router.post("/infoproduct", async (req, res) => {
  try {
    const { infoproduct_id, infoproduct_sku } = req.body || {};
    if (!infoproduct_id && !infoproduct_sku) {
      return res.status(400).json({ error: "missing_infoproduct" });
    }

    // carrega o e-book
    const col = infoproduct_id ? "id" : "sku";
    const val = infoproduct_id || String(infoproduct_sku);
    const { rows } = await query(`
      SELECT id, price_cents
      FROM infoproducts
      WHERE ${infoproduct_id ? "id = $1" : "LOWER(sku)=LOWER($1)"} AND active = true
      LIMIT 1
    `, [val]);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: "infoproduct_not_found" });

    // cria registro de pagamento "pendente" amarrado ao infoproduto (sem draw/sem números)
    const paymentId = String(Date.now()); // ou UUID
    await query(`
      INSERT INTO payments (id, user_id, draw_id, numbers, amount_cents, status, created_at)
      VALUES ($1, $2, NULL, '{}'::smallint[], $3, 'pending', NOW())
    `, [paymentId, req.user?.id || null, p.price_cents]);

    // gere o PIX (reaproveite sua função existente)
    const pix = await createMercadoPagoPreferenceOrPix({
      id: paymentId,
      amount_cents: p.price_cents,
      description: "Compra de e-book / 1 cota",
    });

    return res.json({
      paymentId,
      amount_cents: p.price_cents,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      copy_paste_code: pix.copy_paste_code,
    });
  } catch (e) {
    console.error("[payments/infoproduct]", e);
    return res.status(500).json({ error: "create_infoproduct_payment_failed" });
  }
});


export default router;
