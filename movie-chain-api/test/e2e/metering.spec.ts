/**
 * Step 24: consumption per tenant, counted in the application plane, folded
 * by the control plane — counts only, nothing that identifies a booking or a person.
 */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BookingMeteringModule } from '../../src/metering/booking-metering.module';
import { MeteringModule } from '../../src/metering/metering.module';
import { periodOf, UsageRecorder, usageKey } from '../../src/metering/usage.recorder';
import { StorageService } from '../../src/storage/storage.service';
import { postHold, seedSellable } from '../support/holds';
import { addOperator, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootControlApp, bootTestApp } from '../support/test-app';

const urls = inject('db');
const s3 = inject('s3');
const s3env = { S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_BUCKET: s3.bucket };
let app: INestApplication;
let control: INestApplication;
let redis: Redis;
let op: string;

beforeAll(async () => {
  app = await bootTestApp(urls, { modules: [MeteringModule, BookingMeteringModule], env: { REDIS_URL: inject('redisUrl'), ...s3env } });
  control = await bootControlApp(urls, inject('redisUrl'), s3env);
  redis = new Redis(inject('redisUrl'));
  await asAdmin(urls.adminUrl, (c) => addOperator(c, 'ops@metering.test'));
  op = (await request(control.getHttpServer()).post('/admin/auth/login').send({ email: 'ops@metering.test', password: TEST_PASSWORD }).expect(200)).body.access_token;
});
afterAll(async () => {
  redis.disconnect();
  await Promise.all([app.close(), control.close()]);
});

const ALLOWED = ['tenant_id', 'slug', 'period', 'requests', 'storage_bytes', 'hold_seconds', 'bookings', 'tickets', 'updated_at'];

describe('metering', () => {
  it('counts requests, hold-seconds, bookings, tickets and storage per tenant, in tenant-prefixed Redis keys', async () => {
    const [A, B] = [await seedSellable(urls.adminUrl, 4), await seedSellable(urls.adminUrl, 4)];
    for (let i = 0; i < 3; i++) await request(app.getHttpServer()).get(`/api/v1/screenings/${A.screeningId}/seatmap`).expect(200);
    const hold = (await postHold(app, A.screeningId, [A.seatIds[0]!, A.seatIds[1]!]).expect(201)).body;
    await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('idempotency-key', `mt-${crypto.randomUUID()}`)
      .send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'Grace Wanjiru', email: 'grace@example.test' } })
      .expect(201);
    await request(app.getHttpServer()).get(`/api/v1/screenings/${B.screeningId}/seatmap`).expect(200);
    await app.get(StorageService).putObject(A.tenantId, ['exports', 'probe.csv'], Buffer.alloc(1234), 'text/csv');
    await app.get(UsageRecorder).flush();

    const key = usageKey(A.tenantId, periodOf());
    expect(key).toBe(`usage:{t:${A.tenantId}}:${periodOf()}`);
    const h = await redis.hgetall(key);
    expect(Number(h.requests)).toBeGreaterThanOrEqual(5); // 3 seat maps, a hold, a booking
    expect(Number(h.hold_seconds)).toBeGreaterThan(2 * 290); // 2 seats × ~300 s
    expect(h).toMatchObject({ bookings: '1', tickets: '2' });
    expect(Number((await redis.hgetall(usageKey(B.tenantId, periodOf()))).requests)).toBe(1);
    expect(await redis.call('MEMORY', 'USAGE', key)).toBeGreaterThan(0); // per-tenant footprint is measurable

    // The control plane folds it.
    await request(control.getHttpServer()).post('/admin/metering/aggregate').set('authorization', `Bearer ${op}`).expect(200);
    const res = await request(control.getHttpServer()).get('/admin/metering').query({ period: periodOf() }).set('authorization', `Bearer ${op}`).expect(200);
    const a = res.body.tenants.find((t: { tenant_id: string }) => t.tenant_id === A.tenantId);
    expect(a).toMatchObject({ bookings: 1, tickets: 2, storage_bytes: 1234 });
    expect(a.requests).toBeGreaterThanOrEqual(5);

    // Counts only: no field, and no value, that identifies a booking or a person.
    for (const t of res.body.tenants) expect(Object.keys(t).sort()).toEqual([...ALLOWED].sort());
    expect(res.text).not.toMatch(/grace|example\.test|\+2547|reference|booking_id|ticket_id|consumer/i);
  });

  it('folding is idempotent: running the aggregator twice changes nothing', async () => {
    const get = async () => (await request(control.getHttpServer()).get('/admin/metering').set('authorization', `Bearer ${op}`).expect(200)).body.tenants.map((t: Record<string, unknown>) => ({ ...t, updated_at: null }));
    await request(control.getHttpServer()).post('/admin/metering/aggregate').set('authorization', `Bearer ${op}`).expect(200);
    const once = await get();
    await request(control.getHttpServer()).post('/admin/metering/aggregate').set('authorization', `Bearer ${op}`).expect(200);
    expect(await get()).toEqual(once);
  });

  it('is operator-only', async () => {
    await request(control.getHttpServer()).get('/admin/metering').expect(401);
  });
});
