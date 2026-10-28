/** db:reset — drop and recreate the local database. Refuses anything not on localhost. */
import { Client } from 'pg';
import { loadMigrateConfig } from '../src/config/migrate-config';

async function reset(): Promise<void> {
  const cfg = loadMigrateConfig();
  const url = new URL(cfg.DATABASE_ADMIN_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname))
    throw new Error(`db:reset refuses to run against ${url.hostname}`);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const q = await client.query<{ d: string; c: string }>(`SELECT format('%I', $1::text) AS d`, [dbName]);
    const ident = q.rows[0]!.d;
    await client.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${ident}`);
    console.log(`db:reset recreated ${dbName}`);
  } finally {
    await client.end();
  }
}

reset().catch((e: unknown) => {
  console.error(`db:reset FAILED: ${(e as Error).message}`);
  process.exit(1);
});
