/**
 * db:seed — local development data. Two chains with parallel staff, so
 * cross-tenant behaviour can be poked at by hand. Idempotent.
 *
 *   nyati     chris@nyati.test   (chain_admin)   brian@nyati.test (box_office)
 *   prestige  tabitha@prestige.test (chain_admin)
 *   operator  purity@cinechain.test (control plane, :3001)
 *   all passwords: cinechain-dev-password
 */
import argon2 from 'argon2';
import { Client } from 'pg';
import { loadMigrateConfig } from '../src/config/migrate-config';

const PASSWORD = 'cinechain-dev-password';
const TENANTS = [
  { slug: 'nyati', name: 'Nyati Cinemas', staff: [['chris@nyati.test', 'Chris', 'chain_admin'], ['brian@nyati.test', 'Brian', 'box_office']] },
  { slug: 'prestige', name: 'Prestige Screens', staff: [['tabitha@prestige.test', 'Tabitha', 'chain_admin']] },
] as const;

async function seed(): Promise<void> {
  const cfg = loadMigrateConfig();
  const c = new Client({ connectionString: cfg.DATABASE_ADMIN_URL });
  await c.connect();
  try {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const t of TENANTS) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO tenant (slug, name, status) VALUES ($1, $2, 'active')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [t.slug, t.name],
      );
      const tenantId = rows[0]!.id;
      for (const [email, name, role] of t.staff)
        await c.query(
          `INSERT INTO staff_user (tenant_id, email, display_name, role, password_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
          [tenantId, email, name, role, hash],
        );
      console.log(`  ${t.slug.padEnd(9)} ${tenantId}  ${t.staff.map((s) => s[0]).join(', ')}`);
    }
    await c.query(
      `INSERT INTO platform.operator (email, display_name, password_hash) VALUES ('purity@cinechain.test', 'Purity', $1)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
      [hash],
    );
    console.log('  operator  purity@cinechain.test');
    console.log(`db:seed done (password: ${PASSWORD})`);
  } finally {
    await c.end();
  }
}

seed().catch((e: unknown) => {
  console.error(`db:seed FAILED: ${(e as Error).message}`);
  process.exit(1);
});
