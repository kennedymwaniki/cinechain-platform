/**
 * db:migrate — the only code that connects as the bootstrap admin.
 *
 *   1. 0000_roles.sql runs as admin every time (idempotent; roles are cluster-wide).
 *   2. Every other migration runs under SET ROLE cinechain_migrator, so the
 *      migrator owns every object and cinechain_app owns nothing.
 *   3. The RLS generator is re-applied for every entry in TENANT_TABLES.
 *   4. Login role passwords are set from the environment.
 *
 * Applied migrations are checksummed; editing one after it ran fails loudly.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { loadMigrateConfig, type MigrateConfig } from '../src/config/migrate-config';
import { TENANT_TABLES } from '../src/db/tenant-tables';

const DIR = resolve(__dirname, '../src/db/migrations');
const RLS_SQL = resolve(__dirname, '../src/db/sql/rls.sql');

const LOGIN_ROLES = {
  cinechain_app: 'DB_APP_PASSWORD',
  cinechain_identity: 'DB_IDENTITY_PASSWORD',
  cinechain_control: 'DB_CONTROL_PASSWORD',
  cinechain_sweeper: 'DB_SWEEPER_PASSWORD',
} as const;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function migrate(
  cfg: MigrateConfig = loadMigrateConfig(),
  log: (m: string) => void = console.log,
): Promise<void> {
  const client = new Client({ connectionString: cfg.DATABASE_ADMIN_URL, application_name: 'cinechain-migrate' });
  await client.connect();
  try {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const [roles, ...rest] = files;
    if (roles !== '0000_roles.sql') throw new Error('0000_roles.sql must be the first migration');

    await client.query(readFileSync(join(DIR, roles), 'utf8'));
    log(`  roles     ${roles}`);

    await client.query('SET ROLE cinechain_migrator');
    await client.query(`CREATE TABLE IF NOT EXISTS public.drizzle_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM drizzle_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    for (const file of rest) {
      const sql = readFileSync(join(DIR, file), 'utf8');
      if (!/^-- run-as: migrator\b/m.test(sql)) throw new Error(`${file}: missing "-- run-as: migrator" header`);
      const sum = sha(sql);
      const prior = applied.get(file);
      if (prior) {
        if (prior !== sum) throw new Error(`${file} was edited after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO drizzle_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        log(`  applied   ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${(e as Error).message}`);
      }
    }

    // The RLS generator: one function, applied to every listed table.
    await client.query(readFileSync(RLS_SQL, 'utf8'));
    for (const t of TENANT_TABLES as readonly string[]) {
      const exists = await client.query(`SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS ok`, [t]);
      if (!exists.rows[0]?.ok) throw new Error(`TENANT_TABLES lists "${t}" but no such table exists`);
      await client.query('SELECT public.apply_tenant_rls($1)', [t]);
    }
    log(`  rls       ${TENANT_TABLES.length} tenant-scoped table(s)`);

    await client.query('RESET ROLE');
    for (const [role, key] of Object.entries(LOGIN_ROLES)) {
      // format(%I, %L) quotes server-side: no string interpolation of secrets.
      const { rows } = await client.query<{ stmt: string }>(`SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS stmt`, [
        role,
        cfg[key],
      ]);
      await client.query(rows[0]!.stmt);
    }
    log('  passwords set for login roles');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(
    () => console.log('db:migrate done'),
    (e: unknown) => {
      console.error(`db:migrate FAILED\n${(e as Error).message}`);
      process.exit(1);
    },
  );
}
