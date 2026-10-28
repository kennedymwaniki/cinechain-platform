/**
 * Redis is stopped in the middle of the run. Holds keep working on Postgres
 * alone, and every round still has exactly one winner. This spec starts its
 * OWN Redis container so stopping it does not affect the other specs.
 */
import type { INestApplication } from '@nestjs/common';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RedisHealthBreaker } from '../../src/redis/redis-health.breaker';
import { bootBookingApp, fetchHold, listen, seedSellable } from '../support/holds';
import { race } from './harness';

const urls = inject('db');
let redis: StartedTestContainer;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).withWaitStrategy(Wait.forLogMessage('Ready to accept connections')).start();
  app = await bootBookingApp(urls, `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
  base = await listen(app);
});
afterAll(async () => {
  await app.close(); // must not hang with Redis down
  await redis.stop().catch(() => undefined);
});

describe('redis outage mid-run', () => {
  it('bookings continue, still exactly one winner per seat, zero 5xx', async () => {
    const t = await seedSellable(urls.adminUrl, 8);
    const round = async (seat: string) => {
      const results = await race(20, () => () => fetchHold(base, t.screeningId, [seat]));
      return { created: results.filter((r) => r.status === 201).length, errors: results.filter((r) => r.status >= 500).length };
    };
    for (const seat of t.seatIds.slice(0, 3)) expect(await round(seat)).toEqual({ created: 1, errors: 0 });

    await redis.stop().catch(() => undefined); // a --repeats run finds it already stopped
    for (const seat of t.seatIds.slice(3, 8)) expect(await round(seat), `seat ${seat}`).toEqual({ created: 1, errors: 0 });
    expect(app.get(RedisHealthBreaker).isOpen()).toBe(true);
  });
});
