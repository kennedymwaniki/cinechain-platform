/**
 * FR-44: an expired hold releases its seats with no job on the critical path.
 * The sweeper is NOT running here: Redis TTL plus the takeover clause in the
 * durable INSERT are the whole mechanism.
 */
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, inject, it } from 'vitest';
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

    // The guarantee, stated directly: a request ISSUED 100 ms after expiry gets the seat. (Measuring
    // when a polling loop's response arrives would charge the machine's load to the system.)
    while (Date.now() < expiresAt + 100) await new Promise((r) => setTimeout(r, 5));
    await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201);
  });
});
