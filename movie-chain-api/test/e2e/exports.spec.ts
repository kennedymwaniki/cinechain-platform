/** FR-66: asynchronous CSV export, tenant-prefixed object, short-lived link. Real MinIO + Redis. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { QueueModule } from '../../src/queue/queue.module';
import { ExportModule } from '../../src/reporting/export.module';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD } from '../support/seed';
import { seedScreening } from '../support/seed-screening';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
const s3 = inject('s3');
let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await bootTestApp(urls, {
    modules: [QueueModule, ExportModule],
    env: { REDIS_URL: inject('redisUrl'), S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_BUCKET: s3.bucket },
  });
});
afterAll(() => app.close());

async function admin(label: string) {
  const t = await asAdmin(urls.adminUrl, async (c) => {
    const t = await createTenant(c);
    await addStaff(c, t.id, `exp@${label}.test`, 'chain_admin');
    const s = await seedScreening(c, t.id, { seats: 2, title: '=HYPERLINK("http://evil")' });
    const b = (
      await c.query(
        `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, status, channel, guest_email, guest_name, seat_ids, total_minor, currency, confirmed_at)
         VALUES ($1, 'EXP-1', $2, gen_random_uuid(), 'confirmed', 'online', 'e@x.test', 'E', ARRAY[$3::uuid], 90000, 'KES', now()) RETURNING id`,
        [t.id, s.screeningId, s.seatIds[0]],
      )
    ).rows[0].id;
    await c.query(`INSERT INTO ticket (tenant_id, booking_id, screening_id, seat_id, code_hash, price_minor, currency) VALUES ($1, $2, $3, $4, 'x'::bytea, 90000, 'KES')`, [t.id, b, s.screeningId, s.seatIds[0]]);
    await c.query(`INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status, booking_id) VALUES ($1, $2, $3, 'sold', $4)`, [s.screeningId, s.seatIds[0], t.id, b]);
    return t;
  });
  const tok = (await http().post('/api/v1/auth/staff/login').send({ email: `exp@${label}.test`, password: TEST_PASSWORD, tenant_slug: t.slug })).body.access_token as string;
  return { ...t, tok };
}

const range = { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3 * 86400_000).toISOString() };

async function ready(tok: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await http().get(`/api/v1/reports/exports/${id}`).set('authorization', `Bearer ${tok}`).expect(200);
    if (r.body.status !== 'pending') return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('export never finished');
}

describe('report export (FR-66)', () => {
  it('produces a CSV under t/<tenant>/exports/, behind a 5-minute signed link, with formulas neutralised', async () => {
    const a = await admin('exp-a');
    const created = await http().post('/api/v1/reports/exports').set('authorization', `Bearer ${a.tok}`).send({ kind: 'occupancy', ...range }).expect(201);
    expect(created.body.status).toBe('pending');
    const done = await ready(a.tok, created.body.export_id);
    expect(done).toMatchObject({ status: 'ready', rows: 1, expires_in_s: 300 });
    const url = new URL(done.download_url);
    expect(url.pathname).toBe(`/${s3.bucket}/t/${a.id}/exports/occupancy-${created.body.export_id}.csv`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    const csv = await (await fetch(url)).text();
    expect(csv.split('\r\n')[0]).toBe('screening_id,starts_at,theatre,screen,film,capacity,sold,held');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.endsWith(',2,1,0\r\n')).toBe(true); // capacity 2, sold 1, held 0

    const rev = await http().post('/api/v1/reports/exports').set('authorization', `Bearer ${a.tok}`).send({ kind: 'revenue', ...range }).expect(201);
    const revDone = await ready(a.tok, rev.body.export_id);
    expect(await (await fetch(revDone.download_url)).text()).toContain(',1,1,90000\r\n');
  });

  it("another chain's export is not found, and the object is unreachable without the signature", async () => {
    const a = await admin('exp-b1');
    const b = await admin('exp-b2');
    const created = await http().post('/api/v1/reports/exports').set('authorization', `Bearer ${a.tok}`).send({ kind: 'revenue', ...range }).expect(201);
    const done = await ready(a.tok, created.body.export_id);
    await http().get(`/api/v1/reports/exports/${created.body.export_id}`).set('authorization', `Bearer ${b.tok}`).expect(404);
    const bare = new URL(done.download_url);
    expect((await fetch(`${bare.origin}${bare.pathname}`)).status).toBe(403);
  });
});
