// backend/src/middleware/autoReconcile.js
import { kickReconcilePendingPayments } from '../routes/payments.js';

let _inFlight = false;

/**
 * Dispara reconciliação de PIX pendentes em background, com throttle.
 * Coloque este middleware no app (app.use(autoReconcile)).
 */
export function autoReconcile(req, res, next) {
  if (!_inFlight) {
    _inFlight = true;
    // roda sem await para não atrasar a resposta
    kickReconcilePendingPayments()
      .catch((e) => console.warn('[autoReconcile] error:', e?.message || e))
      .finally(() => { _inFlight = false; });
  }
  next();
}
