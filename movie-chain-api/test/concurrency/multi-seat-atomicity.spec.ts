/** All-or-nothing: {A,B} vs {B,C} → one winner, and the loser holds NOTHING, anywhere. */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { lockKey } from '../../src/inventory/redis-locks';
import { bootBookingApp, fetchHold, listen, seedSellable } from '../support/holds';
import { asAdmin } from '../support/seed';
import { race } from './harness';

const urls = inject('db');
let app: INestApplication;
let base: string;
let redis: Redis;

beforeAll(async () => {
  app = await bootBookingApp(urls, inject('redisUrl'));
  base = await listen(app);
  redis = new Redis(inject('redisUrl'));
});
afterAll(async () => {
  redis.disconnect();
  await app.close();
});

describe('multi-seat atomicity', () => {
  it('{A,B} vs {B,C}: one winner; the loser holds nothing in Redis or Postgres (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const t = await seedSellable(urls.adminUrl, 3);
      const [a, b, c] = t.seatIds as [string, string, string];
      const [ab, bc] = await race(2, (i) => () => fetchHold(base, t.screeningId, i === 0 ? [a, b] : [b, c]));
      expect([ab!.status, bc!.status].sort(), `round ${round}`).toEqual([201, 409]);

      const loserOnly = ab!.status === 201 ? c : a;
      expect(await redis.exists(lockKey(t.tenantId, t.screeningId, loserOnly)), `round ${round}: redis`).toBe(0);
      const { rows } = await asAdmin(urls.adminUrl, (cl) => cl.query('SELECT seat_id FROM seat_lock WHERE screening_id = $1 ORDER BY seat_id', [t.screeningId]));
      const winnerSeats = (ab!.status === 201 ? [a, b] : [b, c]).sort();
      expect(rows.map((r) => r.seat_id), `round ${round}: postgres`).toEqual(winnerSeats);
    }
  });

  it('ten overlapping selections at once over five seats: every seat has at most one holder and no request is half-granted', async () => {
    const t = await seedSellable(urls.adminUrl, 5);
    const s = t.seatIds;
    const picks = Array.from({ length: 10 }, (_, i) => [s[i % 5]!, s[(i + 1) % 5]!]);
    const results = await race(10, (i) => () => fetchHold(base, t.screeningId, picks[i]!));
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const won = results.flatMap((r, i) => (r.status === 201 ? picks[i]! : []));
    expect(new Set(won).size).toBe(won.length); // no seat granted twice
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query('SELECT seat_id FROM seat_lock WHERE screening_id = $1', [t.screeningId]));
    expect(rows.map((r) => r.seat_id).sort()).toEqual([...won].sort()); // and nothing from the losers
  });
});
