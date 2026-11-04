/**
 * Seeds the blockbuster load test (step 25): one NOISY chain (a sell-out
 * on-sale) and five QUIET chains, each with one published screening, priced.
 * Idempotent: re-running reuses the chains and clears their holds. Writes
 * test/load/fixtures/fixtures.json for k6. Admin connection (tooling only).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';
import { loadMigrateConfig } from '../src/config/migrate-config';

const NOISY_TIER = process.env.NOISY_TIER ?? 'standard';
const QUIET_TIER = process.env.QUIET_TIER ?? 'standard';

async function chain(c: Client, slug: string, tier: string, rows: number, perRow: number) {
  let tenantId: string | undefined = (await c.query(`SELECT id FROM tenant WHERE slug = $1`, [slug])).rows[0]?.id;
  if (!tenantId) {
    tenantId = (
      await c.query(
        `INSERT INTO tenant (slug, name, status, tier, hold_seconds, max_seats_per_booking, seat_gap_policy)
         VALUES ($1, $1, 'active', $2, 300, 10, 'off') RETURNING id`,
        [slug, tier],
      )
    ).rows[0].id as string;
    const th = (await c.query(`INSERT INTO theatre (tenant_id, name, city) VALUES ($1, 'Load', 'Loadville') RETURNING id`, [tenantId])).rows[0].id;
    const sc = (await c.query(`INSERT INTO screen (tenant_id, theatre_id, name) VALUES ($1, $2, 'S1') RETURNING id`, [tenantId, th])).rows[0].id;
    await c.query(
      `INSERT INTO seat (tenant_id, screen_id, row_label, seat_number, row_index, col_index)
       SELECT $1, $2, chr(65 + r), n, r, n - 1 FROM generate_series(0, $3::int - 1) r, generate_series(1, $4::int) n`,
      [tenantId, sc, rows, perRow],
    );
    const film = (await c.query(`INSERT INTO film (tenant_id, title, runtime_min) VALUES ($1, 'Avengers: Doomsday', 150) RETURNING id`, [tenantId])).rows[0].id;
    await c.query(
      `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format, status)
       VALUES ($1, $2, $3, now() + interval '3 days', now() + interval '3 days 150 minutes', 60, 'standard', 'published')`,
      [tenantId, sc, film],
    );
    await c.query(`INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from) VALUES ($1, 'standard', 80000, 'KES', now() - interval '1 day')`, [tenantId]);
  }
  await c.query(`UPDATE tenant SET tier = $2, rate_limit_rps = NULL, status = 'active' WHERE id = $1`, [tenantId, tier]);
  const screeningId = (await c.query(`SELECT id FROM screening WHERE tenant_id = $1 LIMIT 1`, [tenantId])).rows[0].id as string;
  await c.query(`DELETE FROM seat_lock WHERE tenant_id = $1 AND status = 'held'`, [tenantId]); // a fresh room each run
  const seatIds = (await c.query(`SELECT st.id FROM seat st JOIN screening s ON s.screen_id = st.screen_id WHERE s.id = $1 ORDER BY st.row_index, st.col_index`, [screeningId])).rows.map((r) => r.id as string);
  return { slug, tenantId, screeningId, seatIds };
}

async function main(): Promise<void> {
  const c = new Client({ connectionString: loadMigrateConfig().DATABASE_ADMIN_URL });
  await c.connect();
  try {
    const noisy = await chain(c, 'load-noisy', NOISY_TIER, 20, 25); // 500 seats: the blockbuster
    const quiet = [];
    for (let i = 1; i <= 5; i++) quiet.push(await chain(c, `load-quiet-${i}`, QUIET_TIER, 10, 20));
    const out = resolve(__dirname, '../test/load/fixtures/fixtures.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ noisy, quiet }, null, 1));
    console.log(`seeded noisy (${NOISY_TIER}, ${noisy.seatIds.length} seats) + ${quiet.length} quiet (${QUIET_TIER}) → ${out}`);
  } finally {
    await c.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
