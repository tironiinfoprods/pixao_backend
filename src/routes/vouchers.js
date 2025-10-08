// backend/src/routes/vouchers.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** GET /api/vouchers/remaining?draw_id=123
 * Usa o campo `remaining` do schema atual (soma).
 */
router.get("/remaining", requireAuth, async (req, res) => {
  const drawId = Number(req.query.draw_id);
  if (!Number.isFinite(drawId)) return res.status(400).json({ error: "invalid_draw_id" });

  try {
    const { rows } = await query(
      `select coalesce(sum(remaining),0)::int as remaining
         from vouchers
        where user_id = $1 and draw_id = $2`,
      [req.user.id, drawId]
    );
    res.json({ remaining: rows?.[0]?.remaining ?? 0 });
  } catch (e) {
    console.error("[vouchers/remaining] fail:", e);
    res.status(500).json({ error: "remaining_failed" });
  }
});

/** POST /api/vouchers/consume
 * body: { draw_id, numbers:[...], reservationId? }
 * - valida se os números ainda estão livres (ignora os que estiverem reservados pelo próprio usuário)
 * - garante saldo (somatório de remaining em vouchers)
 * - grava `numbers` como 'sold'
 * - (opcional) marca a reserva como 'paid'
 * - (opcional) cria um payment sintético (método 'voucher') apenas para histórico/relatórios
 * - decrementa remaining dos vouchers do usuário
 */
router.post("/consume", requireAuth, async (req, res) => {
  const drawId = Number(req.body?.draw_id);
  const nums = Array.isArray(req.body?.numbers)
    ? [...new Set(req.body.numbers.map(n => Number(n)).filter(n => Number.isFinite(n)))]
    : [];
  const reservationId = (req.body?.reservationId || req.body?.reservation_id || null) ?? null;

  if (!Number.isFinite(drawId) || nums.length === 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await query("begin");

    /* 0) (Opcional) Carrega e valida a reserva do próprio usuário */
    let ownedReserved = new Set();
    if (reservationId) {
      const { rows: rrows } = await query(
        `
        select id, user_id, draw_id, numbers, status,
               coalesce(reserved_until, now() + interval '1 second') as reserved_until
          from reservations
         where id = $1
         for update
        `,
        [reservationId]
      );
      const r = rrows?.[0];
      const active =
        r &&
        Number(r.user_id) === Number(req.user.id) &&
        Number(r.draw_id) === Number(drawId) &&
        !/^(paid|expired|cancel)/i.test(String(r.status || "")) &&
        new Date(r.reserved_until).getTime() > Date.now();

      if (!active) {
        await query("rollback");
        return res.status(409).json({ error: "reservation_not_active" });
      }
      const arr = Array.isArray(r.numbers) ? r.numbers.map(Number).filter(Number.isFinite) : [];
      ownedReserved = new Set(nums.filter(n => arr.includes(n)));
      // se o cliente tentar confirmar nº que não estava na reserva, trataremos como "fora da reserva"
    }

    /* 1) Checa conflitos:
          - já vendidos/tomados em `numbers`
          - reservados por OUTRO usuário (em reservations ativas)          */
    // 1a) vendidos
    const { rows: soldRows } = await query(
      `
      select n
        from numbers
       where draw_id = $1
         and n = any($2::smallint[])
         and status in ('sold','taken')
      `,
      [drawId, nums]
    );
    const soldConflicts = new Set(soldRows.map(r => Number(r.n)));

    // 1b) reservados por outros usuários
    const { rows: otherRes } = await query(
      `
      select numbers
        from reservations
       where draw_id = $1
         and user_id <> $2
         and status in ('active','reserved','pending','await')
         and (reserved_until is null or reserved_until > now())
         and numbers && $3::int[]
       for update
      `,
      [drawId, req.user.id, nums]
    );
    const reservedByOthers = new Set();
    for (const rr of otherRes || []) {
      const arr = Array.isArray(rr.numbers) ? rr.numbers.map(Number) : [];
      for (const n of arr) if (nums.includes(n)) reservedByOthers.add(n);
    }

    // 1c) Conflitos finais = vendidos OR reservados por outros OR (quando NÃO tem reserva) status=reserved
    let additionalReserved = new Set();
    if (!reservationId) {
      const { rows: resvRows } = await query(
        `
        select n
          from numbers
         where draw_id = $1
           and n = any($2::smallint[])
           and status = 'reserved'
        `,
        [drawId, nums]
      );
      additionalReserved = new Set(resvRows.map(r => Number(r.n)));
    }

    const conflicts = [...new Set([
      ...soldConflicts,
      ...reservedByOthers,
      ...additionalReserved
    ])].filter(n => !ownedReserved.has(n));

    if (conflicts.length) {
      await query("rollback");
      return res.status(409).json({ error: "numbers_conflict", conflicts });
    }

    /* 2) Calcula saldo total de vouchers (remaining) e trava linhas */
    const { rows: vrows } = await query(
      `
      select id, remaining
        from vouchers
       where user_id = $1 and draw_id = $2 and remaining > 0
       order by created_at asc
       for update skip locked
      `,
      [req.user.id, drawId]
    );
    const totalRemaining = vrows.reduce((acc, r) => acc + Number(r.remaining || 0), 0);
    if (totalRemaining < nums.length) {
      await query("rollback");
      return res.status(409).json({ error: "not_enough_vouchers" });
    }

    /* 3) Efetiva números como 'sold'
          - se não existe, cria sold
          - se existe e está 'available' OU 'reserved' (do próprio), vira 'sold'
          - qualquer outra situação vira conflito */
    for (const n of nums) {
      const up = await query(
        `
        insert into numbers (draw_id, n, status)
        values ($1, $2::smallint, 'sold')
        on conflict (n, draw_id) do update
          set status = 'sold'
          where numbers.status in ('available','reserved')
        returning n, status
        `,
        [drawId, n]
      );

      if (!up.rowCount) {
        await query("rollback");
        return res.status(409).json({ error: "numbers_conflict", conflicts: [n] });
      }
    }

    /* 4) Debita saldo dos vouchers (FIFO) */
    let toConsume = nums.length;
    for (const v of vrows) {
      if (toConsume <= 0) break;
      const take = Math.min(Number(v.remaining), toConsume);
      await query(
        `
        update vouchers
           set remaining   = remaining - $1,
               consumed_at = case when remaining - $1 = 0 then now() else consumed_at end,
               used        = case when remaining - $1 = 0 then true else used end
         where id = $2
        `,
        [take, v.id]
      );
      toConsume -= take;
    }

    /* 4b) (Opcional) Marca a reserva como paga, se informada */
    if (reservationId) {
      await query(
        `update reservations
            set status = 'paid',
                paid_at = now()
          where id = $1`,
        [reservationId]
      );
    }

    /* 4c) (Opcional) Cria um registro em payments para histórico
          -> se falhar por schema diferente, apenas loga e segue */
    try {
      // tenta obter preço do sorteio (se existir)
      const { rows: priceRow } = await query(
        `select coalesce(price_cents, amount_cents, price, 0)::int as price_cents
           from draws
          where id = $1`,
        [drawId]
      );
      const unitCents = Number(priceRow?.[0]?.price_cents || 0);
      const totalCents = unitCents * nums.length;
      const payId = "vch_" + Date.now().toString() + "_" + Math.floor(Math.random() * 1e6);

      // tentativa 1: schema mais completo
      await query(
        `
        insert into payments
          (id, user_id, draw_id, numbers, amount_cents, status, method, created_at, paid_at)
        values
          ($1, $2, $3, $4::smallint[], $5, 'paid', 'voucher', now(), now())
        `,
        [payId, req.user.id, drawId, nums, totalCents]
      );
    } catch (e1) {
      try {
        // tentativa 2: columns básicas
        await query(
          `
          insert into payments
            (user_id, draw_id, numbers, amount_cents)
          values
            ($1, $2, $3::smallint[], 0)
          `,
          [req.user.id, drawId, nums]
        );
      } catch (e2) {
        // apenas loga; não deve invalidar a compra
        console.warn("[vouchers/consume] payments insert skipped:", e1?.message || e1, e2?.message || e2);
      }
    }

    await query("commit");
    res.json({ ok: true, consumed: nums.length });
  } catch (e) {
    await query("rollback");
    console.error("[vouchers/consume] fail:", e);
    res.status(500).json({ error: "consume_failed" });
  }
});

export default router;
