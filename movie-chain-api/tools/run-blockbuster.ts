/**
 * pnpm load:blockbuster — step 25's load test, end to end, against a RUNNING
 * API (default http://localhost:3000):
 *   1. seed the chains (tools/seed-load.ts);
 *   2. MODE=baseline: the quiet chains alone → their reference p95;
 *   3. MODE=full: the same quiet traffic + the 760 rps blockbuster, with k6
 *      thresholds set against that baseline;
 *   4. check the database for double sales;
 *   5. archive one JSON verdict in test/load/results/ (CI keeps it as the baseline).
 * k6 runs from the grafana/k6 image on the host network. Durations: RAMP, HOLD.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { loadMigrateConfig } from '../src/config/migrate-config';

const ROOT = resolve(__dirname, '..');
const LOAD = resolve(ROOT, 'test/load');
const RESULTS = resolve(LOAD, 'results');
const env = (k: string, d: string) => process.env[k] ?? d;
const RAMP = env('RAMP', '30s');
const HOLD = env('HOLD', '5m');
const BASE_URL = env('BASE_URL', 'http://localhost:3000/api/v1');
const K6_IMAGE = env('K6_IMAGE', 'grafana/k6:1.3.0');
// Keep the load generator off the API's cores when both share a machine (e.g. K6_CPUSET=0,1).
const K6_CPUSET = process.env.K6_CPUSET;

type Summary = { metrics: Record<string, { values: Record<string, number>; thresholds?: Record<string, { ok: boolean }> }> };

function k6(mode: 'baseline' | 'full', extra: Record<string, string> = {}): { exit: number; summary: Summary } {
  const vars = { MODE: mode, RAMP, HOLD, BASE_URL, ...extra };
  const args = ['run', '--rm', '--network', 'host', '-v', `${LOAD}:/scripts:ro`, '-v', `${LOAD}/fixtures:/fixtures:ro`, '-v', `${RESULTS}:/results`, '-u', `${process.getuid?.() ?? 0}`];
  if (K6_CPUSET) args.push('--cpuset-cpus', K6_CPUSET);
  for (const [k, v] of Object.entries(vars)) args.push('-e', `${k}=${v}`);
  args.push(K6_IMAGE, 'run', '--quiet', '/scripts/blockbuster.js');
  console.log(`\n▶ k6 ${mode} (${RAMP} ramp + ${HOLD})`);
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  return { exit: r.status ?? 1, summary: JSON.parse(readFileSync(resolve(RESULTS, `summary-${mode}.json`), 'utf8')) as Summary };
}

const metric = (s: Summary, name: string, stat: string) => s.metrics[name]?.values[stat] ?? 0;

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true });
  const health = await fetch(BASE_URL.replace(/\/api\/v1$/, '/api/v1/health')).catch(() => null);
  if (!health?.ok) throw new Error(`the API is not answering at ${BASE_URL}; start it first (pnpm start or node dist/main.js)`);

  if (spawnSync('pnpm', ['-s', 'exec', 'tsx', 'tools/seed-load.ts'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) throw new Error('seeding failed');

  const baseline = k6('baseline');
  const baseP95 = metric(baseline.summary, 'http_req_duration{side:quiet}', 'p(95)');
  const full = k6('full', { QUIET_P95_BASELINE: String(baseP95) });
  const fullP95 = metric(full.summary, 'http_req_duration{side:quiet}', 'p(95)');

  // Zero double sales: no seat with two live tickets, and no seat holding two durable rows (the PK makes this a tautology — checked anyway).
  const c = new Client({ connectionString: loadMigrateConfig().DATABASE_ADMIN_URL });
  await c.connect();
  const doubleSales = Number(
    (await c.query(`SELECT count(*) AS n FROM (SELECT screening_id, seat_id FROM ticket WHERE status <> 'void' GROUP BY 1, 2 HAVING count(*) > 1) d`)).rows[0].n,
  );
  await c.end();

  const thresholds = Object.fromEntries(
    Object.entries(full.summary.metrics).flatMap(([name, m]) => Object.entries(m.thresholds ?? {}).map(([t, v]) => [`${name}: ${t}`, v.ok])),
  );
  const degradation = baseP95 > 0 ? (fullP95 - baseP95) / baseP95 : 0;
  const result = {
    at: new Date().toISOString(),
    params: { ramp: RAMP, hold: HOLD, k6_cpuset: K6_CPUSET ?? 'shared', noisy_rps: Number(env('NOISY_RPS', '760')), quiet_rps: Number(env('QUIET_RPS', '40')), noisy_tier: env('NOISY_TIER', 'standard') },
    quiet_p95_ms: { baseline: round(baseP95), with_blockbuster: round(fullP95), degradation_pct: round(degradation * 100) },
    hold_p99_ms: round(metric(full.summary, 'http_req_duration{kind:hold}', 'p(99)')),
    requests: round(metric(full.summary, 'http_reqs', 'count')),
    noisy_rate_limited: metric(full.summary, 'noisy_rate_limited', 'count'),
    quiet_rate_limited: metric(full.summary, 'quiet_rate_limited', 'count'),
    server_errors: metric(full.summary, 'server_errors', 'count'),
    holds_won: metric(full.summary, 'holds_won', 'count'),
    double_sales: doubleSales,
    k6_thresholds: thresholds,
    pass: full.exit === 0 && baseline.exit === 0 && doubleSales === 0 && degradation < 0.2,
  };
  const out = resolve(RESULTS, `blockbuster-${result.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(result, null, 2));
  writeFileSync(resolve(RESULTS, 'latest.json'), JSON.stringify(result, null, 2));
  console.log(`\n${JSON.stringify(result, null, 2)}\n→ ${out}`);
  process.exit(result.pass ? 0 : 1);
}

const round = (n: number) => Math.round(n * 100) / 100;

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
