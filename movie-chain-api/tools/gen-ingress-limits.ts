/**
 * pnpm ingress:limits — writes deploy/ingress/cinechain-limits.conf from the
 * `tier` table and every tenant's plan (step 25). Run after any tier or plan
 * change, then reload the ingress. Reads as the admin URL (tooling only).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from '../src/config/app-config';
import { loadMigrateConfig } from '../src/config/migrate-config';
import { renderIngressLimits } from '../src/tiering/ingress-limits';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const c = new Client({ connectionString: loadMigrateConfig().DATABASE_ADMIN_URL });
  await c.connect();
  try {
    const tiers = (await c.query(`SELECT code, rate_limit_rps AS "rateLimitRps" FROM tier ORDER BY sort_order`)).rows;
    const tenants = (await c.query(`SELECT slug, tier, rate_limit_rps AS "rateLimitRps" FROM tenant WHERE status IN ('active', 'suspended') ORDER BY slug`)).rows;
    const out = resolve(__dirname, '../deploy/ingress/cinechain-limits.conf');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderIngressLimits(tiers, tenants, cfg.tenantBaseDomain, cfg.rateLimit.perAddressRps));
    console.log(`wrote ${out}: ${tiers.length} tier zone(s), ${tenants.length} tenant(s)`);
  } finally {
    await c.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
