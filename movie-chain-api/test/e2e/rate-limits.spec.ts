/**
 * Step 25: tiers are configuration, and one tenant's blockbuster cannot
 * degrade another's. Real Redis, real Postgres, real HTTP.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { LIMITS_TTL_MS } from '../../src/tiering/tier-config.service';
import { fetchHold, listen, seedSellable } from '../support/holds';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
let base: string;
const q = async (sql: string, p: unknown[] = []) => (await asAdmin(urls.adminUrl, (c) => c.query(sql, p))).rows;

beforeAll(async () => {
  app = await bootTestApp(urls, { env: { REDIS_URL: inject('redisUrl') } });
  base = await listen(app);
});
afterAll(() => app.close());

/** A chain on a real tier: no negotiated test override. */
async function chainOn(tier: string, seats = 4) {
  const t = await seedSellable(urls.adminUrl, seats);
  await q(`UPDATE tenant SET tier = $2, rate_limit_rps = NULL WHERE id = $1`, [t.tenantId, tier]);
  return t;
}
const seatmap = (screeningId: string) => fetch(`${base}/api/v1/screenings/${screeningId}/seatmap`);
/** N requests released together. */
const burst = <T>(n: number, f: () => Promise<T>) => Promise.all(Array.from({ length: n }, f));

describe('per-tenant rate limits', () => {
  it('a Basic chain flooded past its 20 rps gets explained 429s — and another chain flooding at the same moment is untouched', async () => {
    const noisy = await chainOn('basic');
    const quiet = await chainOn('premium');
    const started = Date.now();
    const [n, qq] = await Promise.all([burst(60, () => seatmap(noisy.screeningId)), burst(60, () => seatmap(quiet.screeningId))]);
    // A sliding window grants 20 per second: a burst that straddles a second boundary earns a second budget.
    const seconds = Math.ceil((Date.now() - started) / 1000) + 1;

    const limited = n.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(30);
    expect(n.filter((r) => r.status === 200).length).toBeLessThanOrEqual(20 * seconds + 1);
    expect(n.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(qq.map((r) => r.status)).toEqual(Array(60).fill(200)); // premium allows 200 rps: none of these refused

    const body = (await limited[0]!.json()) as { message: string };
    expect(limited[0]!.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(body).toMatchObject({
      error: 'rate_limited',
      limit: { scope: 'tenant', tier: 'basic', requests_per_second: 20, window_s: 1 },
      retry_after_s: expect.any(Number),
    });
    expect(body.message).toContain('Basic plan allows 20 requests per second');
  });

  it("a forged token naming another chain does not spend that chain's quota", async () => {
    const victim = await chainOn('basic');
    // A hold token signed by nobody, claiming the victim's tenant.
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'hold-v1' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ typ: 'hold', tenant_id: victim.tenantId, hold_id: crypto.randomUUID() })).toString('base64url');
    const forged = `${header}.${claims}.${'A'.repeat(86)}`;
    const attacks = await burst(40, () =>
      fetch(`${base}/api/v1/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ hold_token: forged }) }),
    );
    expect(attacks.every((r) => r.status === 400 || r.status === 401)).toBe(true);
    // The victim's real customers still have their whole budget.
    expect((await burst(15, () => seatmap(victim.screeningId))).map((r) => r.status)).toEqual(Array(15).fill(200));
  });

  it('a hold on a flooded chain is refused with 429 — never a seat-race error, never a 5xx', async () => {
    const t = await chainOn('basic', 30);
    const results = await burst(40, () => fetchHold(base, t.screeningId, [t.seatIds[Math.floor(Math.random() * 30)]!]));
    const statuses = new Set(results.map((r) => r.status));
    expect([...statuses].every((s) => [201, 409, 429].includes(s))).toBe(true);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });
});

describe('tiers are configuration', () => {
  it('a fifth tier is a row: no code, and its limit applies', async () => {
    await q(`INSERT INTO tier (code, name, sort_order, rate_limit_rps, max_theatres, hold_seconds_min, hold_seconds_max, max_seats_per_booking, data_retention_days)
             VALUES ('starter', 'Starter', 5, 5, 1, 120, 180, 4, 90) ON CONFLICT (code) DO NOTHING`);
    const t = await chainOn('starter', 6);
    const r = await burst(20, () => seatmap(t.screeningId));
    expect(r.filter((x) => x.status === 200).length).toBeLessThanOrEqual(6);
    const body = (await r.find((x) => x.status === 429)!.json()) as { limit: unknown };
    expect(body.limit).toMatchObject({ tier: 'starter', requests_per_second: 5 });
    // and its other limits: a 4-seat cap, a 180 s ceiling on the hold window
    await q(`UPDATE tenant SET hold_seconds = 900, max_seats_per_booking = 10 WHERE id = $1`, [t.tenantId]);
    await new Promise((res) => setTimeout(res, 1100));
    const five = await fetchHold(base, t.screeningId, t.seatIds.slice(0, 5));
    expect(five.status === 422 ? five.body.max_seats : five.status).toBe(4);
  });

  it('a plan change takes effect without a deploy, within the limits cache window', async () => {
    const t = await chainOn('basic');
    await q(`UPDATE tenant SET tier = 'premium' WHERE id = $1`, [t.tenantId]);
    await new Promise((res) => setTimeout(res, LIMITS_TTL_MS + 500));
    expect((await burst(60, () => seatmap(t.screeningId))).filter((r) => r.status === 429)).toHaveLength(0);
  }, 30_000);

  it("the plan's theatre allowance is enforced: Basic includes 2", async () => {
    const t = await chainOn('basic');
    const slug = (await q(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))[0]!.slug;
    await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `adm@${slug}.test`, 'chain_admin'));
    const tok = (await request(app.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: `adm@${slug}.test`, password: TEST_PASSWORD, tenant_slug: slug })).body.access_token;
    // seedSellable made one theatre; a second is allowed, a third is not.
    await request(app.getHttpServer()).post('/api/v1/theatres').set('authorization', `Bearer ${tok}`).send({ name: 'Second', city: 'Nairobi' }).expect(201);
    const third = await request(app.getHttpServer()).post('/api/v1/theatres').set('authorization', `Bearer ${tok}`).send({ name: 'Third', city: 'Nairobi' }).expect(422);
    expect(third.body).toMatchObject({ error: 'tier_limit_reached', limit: { name: 'max_theatres', tier: 'basic', value: 2 } });
  });
});
