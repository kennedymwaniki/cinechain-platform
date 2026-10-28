/**
 * Step 15. The sweeper keeps the durable record honest; it is not the release
 * mechanism. These run the real job body against real Postgres and Redis.
 */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { lockKey } from '../../src/inventory/redis-locks';
import { SweeperProcessor } from '../../src/inventory/sweeper.processor';
import { Metrics } from '../../src/metrics/metrics.service';
import { bootBookingApp, postHold, seedSellable } from '../support/holds';
import { asAdmin } from '../support/seed';
import { race } from './harness';

const urls = inject('db');
let app: INestApplication;
let app2: INestApplication;
let redis: Redis;

beforeAll(async () => {
  app = await bootBookingApp(urls, inject('redisUrl'));
  app2 = await bootBookingApp(urls, inject('redisUrl'));
  redis = new Redis(inject('redisUrl'));
});
afterAll(async () => {
  redis.disconnect();
  await Promise.all([app.close(), app2.close()]);
});

const age = (holdId: string, seconds: number) =>
  asAdmin(urls.adminUrl, (c) => c.query(`UPDATE seat_lock SET expires_at = now() - $2::int * interval '1 second' WHERE hold_id = $1`, [holdId, seconds]));
const rowCount = async (holdId: string) =>
  (await asAdmin(urls.adminUrl, (c) => c.query('SELECT count(*)::int AS n FROM seat_lock WHERE hold_id = $1', [holdId]))).rows[0].n as number;

describe('the hold sweeper', () => {
  it('a Redis key deleted directly (eviction): the durable row is reconciled within one sweep and the seat re-holdable', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const h = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    await redis.del(lockKey(t.tenantId, t.screeningId, t.seatIds[0]!)); // simulate eviction
    await age(h.hold_id, 31); // …and the hold's time passing beyond the grace window

    const r = await app.get(SweeperProcessor).tick();
    expect(r.ran).toBe(true);
    expect(await rowCount(h.hold_id)).toBe(0);
    expect(app.get(Metrics).get('sweeper.reclaimed_total', { tenant: t.tenantId })).toBe(1);
    expect(app.get(Metrics).get('sweeper.lag', { tenant: t.tenantId })).toBeGreaterThanOrEqual(31);
    await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201);
  });

  it('never deletes a row whose expiry is within the 30 s grace window', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const live = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const recent = (await postHold(app, t.screeningId, [t.seatIds[1]!]).expect(201)).body;
    await age(recent.hold_id, 20); // expired, but inside the grace
    await app.get(SweeperProcessor).tick();
    expect(await rowCount(live.hold_id)).toBe(1);
    expect(await rowCount(recent.hold_id)).toBe(1);
  });

  it('never blocks on a row locked by a conversion in progress (SKIP LOCKED), and never deletes a sold seat', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const a = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const b = (await postHold(app, t.screeningId, [t.seatIds[1]!]).expect(201)).body;
    await age(a.hold_id, 60);
    await age(b.hold_id, 60);
    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE seat_lock SET status = 'sold', expires_at = NULL WHERE hold_id = $1`, [b.hold_id]));

    const converter = new Client({ connectionString: urls.adminUrl });
    await converter.connect();
    try {
      await converter.query('BEGIN');
      await converter.query('SELECT 1 FROM seat_lock WHERE hold_id = $1 FOR UPDATE', [a.hold_id]);
      const started = Date.now();
      await app.get(SweeperProcessor).tick();
      expect(Date.now() - started).toBeLessThan(2_000); // did not wait for the lock
      expect(await rowCount(a.hold_id)).toBe(1); // skipped, not deleted
      await converter.query('ROLLBACK');
    } finally {
      await converter.end();
    }
    expect(await rowCount(b.hold_id)).toBe(1); // sold: never swept
    await app.get(SweeperProcessor).tick();
    expect(await rowCount(a.hold_id)).toBe(0); // next tick takes it
  });

  it('two app instances run the job; only one executes per tick', async () => {
    for (let round = 0; round < 5; round++) {
      const tickId = `repeat:sweep-expired-holds:${Date.now()}-${round}`; // what both instances receive
      const results = await race(2, (i) => () => (i === 0 ? app : app2).get(SweeperProcessor).tick(tickId));
      expect(results.filter((r) => r.ran), `round ${round}`).toHaveLength(1);
    }
  });
});
