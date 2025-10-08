// backend/src/routes/purchases.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** POST /api/purchases/confirm
 * body: { payment_id, infoproduct_id }
 * - marca a compra como approved
 * - garante um draw aberto para este e-book (ou usa o existente)
 * - cria 1 voucher (com remaining=1)
 */
router.post("/confirm", requireAuth, async (req, res) => {
  const paymentId = String(req.body?.payment_id || "").trim();
  const infoproductId = Number(req.body?.infoproduct_id);
  if (!paymentId || !Number.isFinite(infoproductId)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    // (1) upsert da compra
    const { rows: up } = await query(
      `
      insert into infoproduct_purchases (user_id, infoproduct_id, payment_id, amount_cents, status, created_at, updated_at)
      values ($1,$2,$3,0,'approved',now(),now())
      on conflict (payment_id) do update set status='approved', updated_at=now()
      returning id, user_id
      `,
      [req.user.id, infoproductId, paymentId]
    );
    const purchaseId = up[0].id;

    // (2) acha/abre draw 'open' para este e-book
    const { rows: d } = await query(
      `select id from draws where infoproduct_id=$1 and status='open' order by id desc limit 1`,
      [infoproductId]
    );
    let drawId = d?.[0]?.id;
    if (!drawId) {
      const ins = await query(
        `insert into draws (infoproduct_id, status, total_numbers, created_at, updated_at)
         values ($1,'open',100,now(),now())
         returning id`,
        [infoproductId]
      );
      drawId = ins.rows[0].id;
    }

    // (3) atrela o draw à compra
    await query(`update infoproduct_purchases set draw_id=$1 where id=$2`, [drawId, purchaseId]);

    // (4) emite 1 voucher – preenche campos NOT NULL do seu schema
    await query(
      `
      insert into vouchers (user_id, infoproduct_id, payment_id, remaining, created_at, used, draw_id, purchase_id)
      values ($1, $2, $3, 1, now(), false, $4, $5)
      `,
      [req.user.id, infoproductId, paymentId, drawId, purchaseId]
    );

    await query("commit");
    res.json({ ok: true, draw_id: drawId, purchase_id: purchaseId, vouchers: 1 });
  } catch (e) {
    await query("rollback");
    console.error("[purchases/confirm] fail:", e);
    res.status(500).json({ error: "confirm_failed" });
  }
});

export default router;
