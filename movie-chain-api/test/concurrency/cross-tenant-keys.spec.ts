/** Correction 3: tenant AND screening in one hash tag. Identical ids in two tenants never collide. */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { lockKey, RedisLocks } from '../../src/inventory/redis-locks';
import { bootTestApp } from '../support/test-app';
import { race } from './harness';

let app: INestApplication;
let redis: Redis;

beforeAll(async () => {
  app = await bootTestApp(inject('db'), { env: { REDIS_URL: inject('redisUrl') } });
  redis = new Redis(inject('redisUrl'));
});
afterAll(async () => {
  redis.disconnect();
  await app.close();
});

describe('cross-tenant keys', () => {
  it('identical screening and seat UUIDs in two tenants: both acquire, simultaneously', async () => {
    const [tA, tB] = [crypto.randomUUID(), crypto.randomUUID()];
    const screeningId = crypto.randomUUID();
    const seatIds = [crypto.randomUUID(), crypto.randomUUID()];
    const locks = app.get(RedisLocks);
    const results = await race(2, (i) => () => locks.acquire({ tenantId: i === 0 ? tA : tB, screeningId, holdId: crypto.randomUUID(), seatIds }, 10_000, {}));
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(lockKey(tA, screeningId, seatIds[0]!)).not.toBe(lockKey(tB, screeningId, seatIds[0]!));
  });

  it('every key of one hold shares a single cluster slot', async () => {
    const t = crypto.randomUUID();
    const s = crypto.randomUUID();
    const tags = [lockKey(t, s, crypto.randomUUID()), lockKey(t, s, crypto.randomUUID())].map((k) => k.match(/\{[^}]+\}/)![0]);
    expect(new Set(tags).size).toBe(1);
    expect(tags[0]).toContain(t);
    expect(tags[0]).toContain(s);
  });
});
