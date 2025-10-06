// backend/src/routes/admin_config.js
import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getTicketPriceCents, setTicketPriceCents } from "../services/config.js";

const router = Router();

/**
 * GET /api/admin/config/ticket-price
 * Retorna o preço atual (em centavos)
 */
router.get("/ticket-price", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const v = await getTicketPriceCents();
    return res.json({ price_cents: v });
  } catch (e) {
    console.error("[admin/config] GET ticket-price error:", e);
    return res.status(500).json({ error: "config_read_failed" });
  }
});

/**
 * PATCH /api/admin/config/ticket-price
 * Body: { price_cents: number }
 * Atualiza o preço (em centavos)
 */
router.patch("/ticket-price", requireAuth, requireAdmin, async (req, res) => {
  try {
    const raw = req.body?.price_cents;
    const saved = await setTicketPriceCents(raw);
    return res.json({ ok: true, price_cents: saved });
  } catch (e) {
    console.error("[admin/config] PATCH ticket-price error:", e);
    return res.status(400).json({ error: "invalid_price" });
  }
});

export default router;
