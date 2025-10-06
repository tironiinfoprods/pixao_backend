// backend/src/routes/autopay_runner.js
import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { runAutopayForOpenDraws, ensureAutopayForDraw } from "../services/autopayRunner.js";

const router = Router();

/**
 * Dispara autopay em lote para sorteios abertos.
 * POST /api/admin/autopay/run?force=true&limit=50
 */
router.post("/run", requireAuth, requireAdmin, async (req, res) => {
  const force = String(req.query.force || "").toLowerCase() === "true";
  const limit = Number(req.query.limit || 50) | 0;
  console.log("[autopay.route] POST /run", { force, limit, at: new Date().toISOString() });

  const out = await runAutopayForOpenDraws({ force, limit });
  return res.json(out);
});

/**
 * Dispara (ou garante) autopay para um draw específico.
 * POST /api/admin/autopay/run/:drawId?force=true
 */
router.post("/run/:drawId", requireAuth, requireAdmin, async (req, res) => {
  const drawId = Number(req.params.drawId);
  const force = String(req.query.force || "").toLowerCase() === "true";
  console.log("[autopay.route] POST /run/:drawId", { drawId, force, at: new Date().toISOString() });

  const out = await ensureAutopayForDraw(drawId, { force });
  return res.json(out);
});

export default router;
