import { query } from './db/pg.js';
import { hashPassword } from './utils.js';

export async function ensureSchema() {
  // Tabelas
  await query(`
    create table if not exists users (
      id serial primary key,
      name text not null,
      email text unique not null,
      pass_hash text not null,
      is_admin boolean default false,
      created_at timestamptz default now()
    );

    create table if not exists draws (
      id serial primary key,
      status text not null default 'open',
      opened_at timestamptz default now(),
      closed_at timestamptz
    );

    create table if not exists numbers (
      draw_id int references draws(id) on delete cascade,
      n smallint not null,
      status text not null default 'available',
      reservation_id uuid,
      primary key (draw_id, n)
    );

    create table if not exists reservations (
      id uuid primary key,
      user_id int references users(id) on delete cascade,
      draw_id int references draws(id) on delete cascade,
      numbers int[] not null,
      status text not null default 'active',
      expires_at timestamptz not null,
      payment_id text,
      created_at timestamptz default now()
    );

    create table if not exists payments (
      id text primary key,
      user_id int references users(id) on delete set null,
      draw_id int references draws(id) on delete set null,
      numbers int[] not null,
      amount_cents int not null,
      status text not null,
      qr_code text,
      qr_code_base64 text,
      created_at timestamptz default now(),
      paid_at timestamptz
    );
  `);

  // Sorteio aberto
  const open = await query(`select id from draws where status='open' order by id desc limit 1`);
  let drawId;
  if (open.rows.length) {
    drawId = open.rows[0].id;
  } else {
    const ins = await query(`insert into draws(status) values('open') returning id`);
    drawId = ins.rows[0].id;
  }

  // Garante 100 números (00-99)
  const count = await query(`select count(*)::int as c from numbers where draw_id=$1`, [drawId]);
  if (count.rows[0].c < 100) {
    await query('delete from numbers where draw_id=$1', [drawId]);
    const tuples = [];
    for (let i = 0; i < 100; i++) {
      tuples.push(`($1, ${i}, 'available', null)`);
    }
    const sql = `insert into numbers(draw_id, n, status, reservation_id) values ${tuples.join(', ')}`;
    await query(sql, [drawId]);
  }

  // Usuário de teste
  const email = 'teste@newstore.com';
  const exists = await query('select 1 from users where email=$1', [email]);
  if (!exists.rows.length) {
    const pass = await hashPassword('123456');
    await query(
      'insert into users(name, email, pass_hash, is_admin) values($1,$2,$3,$4)',
      ['Teste', email, pass, true]
    );
  }
}
