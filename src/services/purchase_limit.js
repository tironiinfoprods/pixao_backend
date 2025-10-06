// backend/src/services/purchase_limit.js
import { query } from "../db.js";

const MAX = Number(process.env.MAX_NUMBERS_PER_USER || 20);

// Status que devem CONTAR para o limite (reservado OU pago OU pendente etc.)
const STATUSES = [
  // pt
  "reservado", "pago", "pendente", "aprovado", "vendido", "indisponivel",
  "confirmado", "processando", "aguardando",
  // en
  "reserved", "paid", "pending", "approved", "sold", "taken",
  "confirmed", "processing", "awaiting",
];

// ————————————————————————————————
// util: descobrir coluna de usuário na tabela
async function resolveUserColumn(table) {
  const { rows } = await query(
    `
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = $1
    `,
    [table]
  );
  const cols = rows.map(r => r.column_name);

  // nomes comuns
  const candidates = [
    "user_id", "client_id", "customer_id", "account_id",
    "buyer_id", "participant_id", "owner_id"
  ];
  return candidates.find(c => cols.includes(c)) || null;
}

// conta via tabela numbers (se ela guardar o usuário)
async function countViaNumbers(userId, drawId, userCol) {
  const sql = `
    select count(*)::int as cnt
      from numbers
     where draw_id = $1
       and ${userCol} = $2
       and lower(coalesce(status, '')) = ANY($3)
  `;
  const { rows } = await query(sql, [
    drawId,
    userId,
    STATUSES.map(s => s.toLowerCase()),
  ]);
  return rows?.[0]?.cnt ?? 0;
}

// fallback: conta via reservations (se numbers não guardar o usuário)
async function countViaReservations(userId, drawId) {
  const userCol = await resolveUserColumn("reservations");
  if (!userCol) return 0;

  // tenta achar coluna FK para numbers
  const { rows: fkRows } = await query(
    `
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'reservations'
       and column_name in ('number_id','numbers_id','num_id','n_id')
    `
  );
  const numCol = fkRows?.[0]?.column_name || null;

  // tenta draw_id direto em reservations
  const { rows: drawRows } = await query(
    `
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'reservations'
       and column_name in ('draw_id','sorteio_id')
    `
  );
  const drawCol = drawRows?.[0]?.column_name || null;

  if (numCol) {
    const sql = `
      select count(*)::int as cnt
        from reservations r
        join numbers n on n.id = r.${numCol}
       where n.draw_id = $1
         and r.${userCol} = $2
         and lower(coalesce(n.status, r.status, '')) = ANY($3)
    `;
    const { rows } = await query(sql, [
      drawId,
      userId,
      STATUSES.map(s => s.toLowerCase()),
    ]);
    return rows?.[0]?.cnt ?? 0;
  }

  if (drawCol) {
    const sql = `
      select count(*)::int as cnt
        from reservations r
       where r.${drawCol} = $1
         and r.${userCol} = $2
         and lower(coalesce(r.status, '')) = ANY($3)
    `;
    const { rows } = await query(sql, [
      drawId,
      userId,
      STATUSES.map(s => s.toLowerCase()),
    ]);
    return rows?.[0]?.cnt ?? 0;
  }

  return 0;
}

export async function getUserCountInDraw(userId, drawId) {
  const userCol = await resolveUserColumn("numbers");
  if (userCol) return countViaNumbers(userId, drawId, userCol);
  return countViaReservations(userId, drawId);
}

export async function checkUserLimit(userId, drawId, addingCount = 1) {
  const current = await getUserCountInDraw(userId, drawId);
  const blocked = current >= MAX || current + addingCount > MAX;
  return { blocked, current, max: MAX };
}

export async function assertUserUnderLimit(userId, drawId, addingCount = 1) {
  const { blocked, current, max } = await checkUserLimit(userId, drawId, addingCount);
  if (blocked) {
    const err = new Error("max_numbers_reached");
    err.status = 409;
    err.code = "max_numbers_reached";
    err.payload = { current, max };
    throw err;
  }
  return { current, max };
}
