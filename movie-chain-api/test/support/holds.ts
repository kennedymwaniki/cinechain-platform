import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueueModule } from '../../src/queue/queue.module';
import { SweeperModule } from '../../src/inventory/sweeper.module';
import { asAdmin, createTenant } from './seed';
import { seedScreening } from './seed-screening';
import { bootTestApp } from './test-app';

type Urls = { adminUrl: string; appUrl: string; identityUrl: string; sweeperUrl: string };

/** A tenant with one published screening of N seats and a standard price. */
export async function seedSellable(adminUrl: string, seats = 10, tenantCols = '') {
  return asAdmin(adminUrl, async (c) => {
    const tenantId = (await createTenant(c)).id;
    if (tenantCols) await c.query(`UPDATE tenant SET ${tenantCols} WHERE id = $1`, [tenantId]);
    const s = await seedScreening(c, tenantId, { seats });
    await c.query(
      `INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from) VALUES ($1, 'standard', 80000, 'KES', now() - interval '1 day')`,
      [tenantId],
    );
    return { tenantId, ...s };
  });
}

/** The real API with Redis, BullMQ and the sweeper (whose scheduled ticks tests may also call directly). */
export function bootBookingApp(urls: Urls, redisUrl: string, env: Record<string, string> = {}) {
  return bootTestApp(urls, {
    modules: [QueueModule, SweeperModule],
    env: { REDIS_URL: redisUrl, SWEEPER_DATABASE_URL: urls.sweeperUrl, DATABASE_POOL_MAX: '40', ...env },
  });
}

export const postHold = (app: INestApplication, screeningId: string, seatIds: string[]) =>
  request(app.getHttpServer()).post(`/api/v1/screenings/${screeningId}/holds`).send({ seat_ids: seatIds });

/** Real sockets for the stampede: supertest per-request listeners would serialise the race. */
export async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

export async function fetchHold(base: string, screeningId: string, seatIds: string[]) {
  const res = await fetch(`${base}/api/v1/screenings/${screeningId}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seat_ids: seatIds }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
