// src/db/init.js
import pg from 'pg';
import { getPool } from './pg.js';

const env = process.env;
const dbName = env.PGDATABASE || 'postgres';
const dbToCheck = env.DB_NAME || 'minha_app';

export async function ensureDatabase() {
  const adminUrl =
    env.DATABASE_ADMIN_URL ||
    (env.DATABASE_URL ? env.DATABASE_URL.replace(`/${dbName}`, '/postgres') : null);

  if (!adminUrl) {
    console.warn('[init] Nenhuma connection string admin encontrada, pulando criação de banco');
    return;
  }

  const adminPool = new pg.Pool({
    connectionString: adminUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const res = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbToCheck]
    );

    if (res.rowCount === 0) {
      console.log(`[init] Database "${dbToCheck}" não existe. Criando...`);
      await adminPool.query(`CREATE DATABASE "${dbToCheck}"`);
      console.log(`[init] Database "${dbToCheck}" criado com sucesso.`);
    } else {
      console.log(`[init] Database "${dbToCheck}" já existe ✅`);
    }
  } catch (err) {
    console.warn(
      '[init] Não foi possível verificar/criar banco (provável Supabase restrito):',
      err.message
    );
  } finally {
    await adminPool.end();
  }
}
