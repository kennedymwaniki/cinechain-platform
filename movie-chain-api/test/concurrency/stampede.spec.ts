/**
 * §7.1: one seat, one holder. 200 simultaneous requests for one seat, over
 * real sockets, against real Redis and Postgres.
 */
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RedisLocks } from '../../src/inventory/redis-locks';
import { bootBookingApp, fetchHold, listen, seedSellable } from '../support/holds';
import { asAdmin } from '../support/seed';
import { race } from './harness';

const urls = inject('db');
let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await bootBookingApp(urls, inject('redisUrl'));
  base = await listen(app);
});
afterAll(() => app.close());

describe('stampede', () => {
  it('200 simultaneous requests for one seat: exactly 1× 201, 199× 409, zero 5xx', async () => {
    const t = await seedSellable(urls.adminUrl, 4);
    const results = await race(200, () => () => fetchHold(base, t.screeningId, [t.seatIds[0]!]));
    const by = (s: number) => results.filter((r) => r.status === s).length;
    expect({ created: by(201), conflict: by(409), errors: results.filter((r) => r.status >= 500).length }).toEqual({
      created: 1,
      conflict: 199,
      errors: 0,
    });
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query('SELECT count(*)::int AS n FROM seat_lock WHERE seat_id = $1', [t.seatIds[0]]));
    expect(rows[0].n).toBe(1);
  });

  // The HTTP test above would still pass with a broken Lua script, because
  // the Postgres primary key catches what Redis lets through. This one pins
  // the script itself: replace it with GET-then-SET and it fails.
  it('the Redis acquire alone: 200 concurrent attempts on one seat, exactly one wins', async () => {
    const locks = app.get(RedisLocks);
    const ref = { tenantId: crypto.randomUUID(), screeningId: crypto.randomUUID(), seatIds: [crypto.randomUUID()] };
    const results = await race(200, () => () => locks.acquire({ ...ref, holdId: crypto.randomUUID() }, 10_000, {}));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
