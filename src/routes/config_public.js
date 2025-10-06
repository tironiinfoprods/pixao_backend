import { Router } from "express";
import { getTicketPriceCents } from "../services/config.js";

const router = Router();
// GET /api/config  -> { ticket_price_cents }
router.get("/", async (_req, res) => {
  const ticket_price_cents = await getTicketPriceCents();
  res.json({ ticket_price_cents });
});

export default router;
