// backend/src/routes/purchases.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/purchases/confirm
 * body: { payment_id: string, infoproduct_id: number }
 *
 * - marca a compra como approved (infoproduct_purchases)
 * - garante draw "open" para esse infoproduto (draws)
 * - cria 1 voucher alinhado ao schema (vouchers)
 *   => vouchers: (id uuid, user_id int, infoproduct_id bigint NOT NULL,
 *                 payment_id text NOT NULL FK payments(id),
 *                 remaining smallint DEFAULT 1, used boolean, draw_id bigint, purchase_id bigint)
 */
router.post("/confirm", requireAuth, async (req, res) => {
  const paymentId = String(req.body?.payment_id || "").trim();
  // no teu DB infoproduct_id é BIGINT; aqui aceitamos number "normal"
  const infoproductId = Number(req.body?.infoproduct_id);

  if (!paymentId || !Number.isFinite(infoproductId)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // (0) garante que o payment existe (FK em vouchers exige isso)
    const pay = await query(
      `select id, user_id from payments where id = $1`,
      [paymentId]
    );
    if (!pay.rows?.length) {
      await query("rollback");
      return res.status(400).json({ error: "payment_not_found" });
    }
    // (opcional) checar se pertence ao usuário logado
    if (pay.rows[0].user_id && pay.rows[0].user_id !== req.user.id) {
      await query("rollback");
      return res.status(403).json({ error: "payment_does_not_belong_to_user" });
    }

    // (1) upsert da compra
    const up = await query(
      `
      insert into infoproduct_purchases
        (user_id, infoproduct_id, payment_id, amount_cents, status, created_at, updated_at)
      values
        ($1,$2,$3,0,'approved',now(),now())
      on conflict (payment_id)
        do update set status='approved', updated_at=now()
      returning id
      `,
      [req.user.id, infoproductId, paymentId]
    );
    const purchaseId = up.rows[0].id;

    // (2) acha ou abre draw "open" desse infoproduto
    let drawId = null;
    {
      const d = await query(
        `select id from draws where infoproduct_id=$1 and status='open' order by id desc limit 1`,
        [infoproductId]
      );
      drawId = d.rows?.[0]?.id ?? null;

      if (!drawId) {
        const ins = await query(
          `insert into draws (infoproduct_id, status, total_numbers, created_at, updated_at)
           values ($1,'open',100,now(),now())
           returning id`,
          [infoproductId]
        );
        drawId = ins.rows[0].id;
      }
    }

    // (3) liga a compra ao draw
    await query(
      `update infoproduct_purchases set draw_id=$1 where id=$2`,
      [drawId, purchaseId]
    );

    // (4) emite 1 voucher (schema exige infoproduct_id e payment_id)
    await query(
      `insert into vouchers
         (user_id, infoproduct_id, payment_id, remaining, used, draw_id, purchase_id, created_at)
       values
         ($1,      $2,            $3,          1,        false, $4,     $5,         now())`,
      [req.user.id, infoproductId, paymentId, drawId, purchaseId]
    );

    await query("commit");
    return res.json({ ok: true, draw_id: drawId, purchase_id: purchaseId, vouchers: 1 });
  } catch (e) {
    await query("rollback");
    console.error("[purchases/confirm] fail:", e);
    return res.status(500).json({ error: "confirm_failed" });
  }
});

export default router;
