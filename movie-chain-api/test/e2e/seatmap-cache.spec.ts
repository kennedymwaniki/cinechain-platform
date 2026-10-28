import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SeatmapService } from '../../src/inventory/seatmap.service';
import { asAdmin, createTenant } from '../support/seed';
import { lockSeat, seedScreening } from '../support/seed-screening';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
let s: Awaited<ReturnType<typeof seedScreening>>;
let tenantId: string;

beforeAll(async () => {
  await asAdmin(urls.adminUrl, async (c) => {
    tenantId = (await createTenant(c)).id;
    s = await seedScreening(c, tenantId, { seats: 3 });
  });
  app = await bootTestApp(urls, { env: { REDIS_URL: inject('redisUrl') } });
});
afterAll(() => app.close());

describe('seat map cache (5 s, Redis)', () => {
  it('the second read within 5 s hits Redis, not Postgres; after expiry it reloads', async () => {
    const svc = app.get(SeatmapService);
    const before = svc.dbLoads;
    await request(app.getHttpServer()).get(`/api/v1/screenings/${s.screeningId}/seatmap`).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/screenings/${s.screeningId}/seatmap`).expect(200);
    expect(svc.dbLoads - before).toBe(1);

    await asAdmin(urls.adminUrl, (c) => lockSeat(c, tenantId, s.screeningId, s.seatIds[0]!, 'sold'));
    await new Promise((r) => setTimeout(r, 5_200));
    const after = await request(app.getHttpServer()).get(`/api/v1/screenings/${s.screeningId}/seatmap`).expect(200);
    expect(svc.dbLoads - before).toBe(2);
    expect(after.body.seats.find((x: { id: string }) => x.id === s.seatIds[0]).state).toBe('taken');
  });
});
