/**
 * FR-44: an expired hold releases its seats with no job on the critical path.
 * The sweeper is NOT running here: Redis TTL plus the takeover clause in the
 * durable INSERT are the whole mechanism.
 */
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { HoldService } from '../../src/inventory/hold.service';
import { toSystemContext } from '../../src/tenancy/system-context';
import { postHold, seedSellable } from '../support/holds';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;

beforeAll(async () => {
  app = await bootTestApp(urls, { env: { REDIS_URL: inject('redisUrl') } }); // no SweeperModule
});
afterAll(() => app.close());

describe('expiry', () => {
  it('a 2 s hold is re-holdable within 100 ms of its expiry, with the sweeper disabled', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const first = await app.get(HoldService).place({
      ctx: toSystemContext({ tenantId: t.tenantId }, { kind: 'guest' }),
      screeningId: t.screeningId,
      seatIds: [t.seatIds[0]!],
      ttlSeconds: 2,
      channel: 'online',
      heldByStaff: null,
    });
    const expiresAt = Date.parse(first.expires_at);
    await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(409);

    while (Date.now() < expiresAt) await new Promise((r) => setTimeout(r, 10));
    let res = await postHold(app, t.screeningId, [t.seatIds[0]!]);
    while (res.status === 409 && Date.now() - expiresAt < 1_000) res = await postHold(app, t.screeningId, [t.seatIds[0]!]);
    expect(res.status).toBe(201);
    expect(Date.now() - expiresAt).toBeLessThan(100 + 50); // + the request's own round trip
  });
});
