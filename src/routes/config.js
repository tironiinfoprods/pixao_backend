// src/routes/config.js
import { Router } from "express";
import {
  getTicketPriceCents,
  setTicketPriceCents,
  getBannerTitle,
  setBannerTitle,
  getMaxNumbersPerSelection,
  setMaxNumbersPerSelection,
} from "../services/config.js";

const router = Router();

/**
 * GET /api/config
 * Retorna as chaves públicas usadas no front.
 */
router.get("/", async (_req, res) => {
  try {
    const [price_cents, banner_title, max_numbers_per_selection] = await Promise.all([
      getTicketPriceCents(),
      getBannerTitle(),
      getMaxNumbersPerSelection(),
    ]);

    res.json({
      ticket_price_cents: price_cents,
      banner_title,
      max_numbers_per_selection,
    });
  } catch (e) {
    console.error("[config][GET] error", e);
    res.status(500).json({ error: "config_failed" });
  }
});

/**
 * POST /api/config
 * Atualiza banner_title e max_numbers_per_selection (e opcionalmente price_cents).
 * O preço você já atualiza pela rota antiga; aqui deixo suportado também.
 */
router.post("/", async (req, res) => {
  try {
    const { banner_title, max_numbers_per_selection, ticket_price_cents } = req.body || {};

    if (banner_title !== undefined) {
      await setBannerTitle(banner_title);
    }
    if (max_numbers_per_selection !== undefined) {
      await setMaxNumbersPerSelection(max_numbers_per_selection);
    }
    if (ticket_price_cents !== undefined) {
      await setTicketPriceCents(ticket_price_cents);
    }

    const payload = {
      ticket_price_cents: await getTicketPriceCents(),
      banner_title: await getBannerTitle(),
      max_numbers_per_selection: await getMaxNumbersPerSelection(),
    };

    res.json({ ok: true, ...payload });
  } catch (e) {
    console.error("[config][POST] error", e);
    res.status(500).json({ error: "config_update_failed" });
  }
});

export default router;
