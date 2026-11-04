/**
 * Step 27: suspend, reactivate, and offboard — exported, verified, then
 * PROVABLY erased — against both planes, real Postgres, Redis and MinIO.
 */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DeletionReportSigner } from '../../src/control/offboarding/deletion-report';
import { TENANT_TABLES } from '../../src/db/tenant-tables';
import { LogVerificationMailer } from '../../src/identity/verification-mailer';
import { lockKey } from '../../src/inventory/redis-locks';
import { assertCoversEveryTenantTable, DELETION_ORDER } from '../../src/lifecycle/tenant-data';
import { LifecycleModule } from '../../src/lifecycle/lifecycle.module';
import { QueueModule } from '../../src/queue/queue.module';
import { StorageService } from '../../src/storage/storage.service';
import { TenantRegistry } from '../../src/tenancy/tenant-registry.service';
import { postHold, seedSellable } from '../support/holds';
import { addOperator, addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootControlApp, bootTestApp } from '../support/test-app';

const urls = inject('db');
const s3 = inject('s3');
const s3env = { S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_BUCKET: s3.bucket };
let app: INestApplication;
let control: INestApplication;
let redis: Redis;
let op: string;
const api = () => request(app.getHttpServer());
const ctl = () => request(control.getHttpServer());
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await asAdmin(urls.adminUrl, (c) => c.query(sql, p))).rows as T[];
const opAuth = () => ({ authorization: `Bearer ${op}` });

beforeAll(async () => {
  app = await bootTestApp(urls, { modules: [QueueModule, LifecycleModule], env: { REDIS_URL: inject('redisUrl'), ...s3env } });
  control = await bootControlApp(urls, inject('redisUrl'), s3env);
  redis = new Redis(inject('redisUrl'));
  await asAdmin(urls.adminUrl, (c) => addOperator(c, 'ops@offboard.test'));
  op = (await ctl().post('/admin/auth/login').send({ email: 'ops@offboard.test', password: TEST_PASSWORD }).expect(200)).body.access_token;
});
afterAll(async () => {
  redis.disconnect();
  await Promise.all([app.close(), control.close()]);
});

/** Counts per tenant table for one tenant, as the admin (no RLS): the independent check. */
async function countsFor(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TENANT_TABLES) out[t] = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id = $1`, [tenantId]))[0]!.n;
  return out;
}

async function consumerToken(email: string): Promise<string> {
  await api().post('/api/v1/auth/register').send({ email, password: 'consumer-password-1' }).expect(202);
  const link = app.get(LogVerificationMailer).outbox.get(email)!;
  await api().post('/api/v1/auth/verify-email').send({ token: new URL(link).searchParams.get('token') }).expect(200);
  return (await api().post('/api/v1/auth/login').send({ email, password: 'consumer-password-1' }).expect(200)).body.access_token;
}

const book = async (screeningId: string, seats: string[], contact: { name: string; email: string }, token?: string) => {
  const h = api().post(`/api/v1/screenings/${screeningId}/holds`);
  const hold = (await (token ? h.set('authorization', `Bearer ${token}`) : h).send({ seat_ids: seats }).expect(201)).body;
  const b = api().post('/api/v1/bookings').set('idempotency-key', `ob-${crypto.randomUUID()}`);
  return (await (token ? b.set('authorization', `Bearer ${token}`) : b).send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact }).expect(201)).body;
};

const staffLogin = (slug: string, email: string) => api().post('/api/v1/auth/staff/login').send({ email, password: TEST_PASSWORD, tenant_slug: slug });

/** A chain with a row in EVERY tenant table. */
async function fullChain(label: string, consumer: { token: string; email: string }) {
  const t = await seedSellable(urls.adminUrl, 8, 'loyalty_points_per_unit = 1');
  const slug = (await q<{ slug: string }>(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))[0]!.slug;
  const adminId = await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `admin@${label}.test`, 'chain_admin'));
  await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `door@${label}.test`, 'box_office'));
  const mine = await book(t.screeningId, [t.seatIds[0]!], { name: 'Wanjiku', email: consumer.email }, consumer.token);
  const guest = await book(t.screeningId, [t.seatIds[1]!, t.seatIds[2]!], { name: 'Guest', email: `guest@${label}.test` });
  await api().post(`/api/v1/bookings/${guest.booking_id}/cancel`).set('booking-token', guest.manage_token).send({ seat_ids: [t.seatIds[2]] }).expect(201);
  const door = (await staffLogin(slug, `door@${label}.test`).expect(200)).body.access_token;
  await api().post('/api/v1/tickets/redeem').set('authorization', `Bearer ${door}`).send({ code: guest.tickets[0].code, screening_id: t.screeningId, device_id: 'gate' }).expect(200);
  await q(`INSERT INTO staff_activation (tenant_id, token_hash, staff_user_id, expires_at) VALUES ($1, md5(random()::text), $2, now() + interval '1 day')`, [t.tenantId, adminId]);
  await q(`INSERT INTO staff_theatre (tenant_id, staff_user_id, theatre_id) VALUES ($1, $2, $3)`, [t.tenantId, adminId, t.theatreId]);
  await q(`INSERT INTO report_export (tenant_id, kind, from_at, to_at, requested_by) VALUES ($1, 'revenue', now() - interval '1 day', now(), $2)`, [t.tenantId, adminId]);
  await q(`INSERT INTO payment_webhook_event (tenant_id, provider, event_id, payment_id, status) SELECT tenant_id, 'mpesa', 'ev-' || id, id, 'captured' FROM payment WHERE tenant_id = $1 LIMIT 1`, [t.tenantId]);
  await app.get(StorageService).putObject(t.tenantId, ['films', 'poster.png'], Buffer.from('poster'), 'image/png');
  const liveHold = (await postHold(app, t.screeningId, [t.seatIds[5]!]).expect(201)).body; // a live hold to release
  return { ...t, slug, mine, guest, liveHold, doorToken: door };
}

async function advanceUntil(tenantId: string, status: string, ms = 60_000) {
  let last: { status?: string; last_error?: string | null } = {};
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    last = (await ctl().post(`/admin/tenants/${tenantId}/offboard/advance`).set(opAuth())).body;
    if (last.status === status) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`offboarding never reached ${status}: ${JSON.stringify(last)}`);
}

describe('the deletion order is driven by TENANT_TABLES', () => {
  it('covers every tenant table exactly once; a missing table refuses to run', () => {
    expect(() => assertCoversEveryTenantTable()).not.toThrow();
    expect(() => assertCoversEveryTenantTable(DELETION_ORDER.filter((t) => t !== 'ticket'))).toThrow(/missing: ticket/);
  });
});

describe('tenant lifecycle', () => {
  let A: Awaited<ReturnType<typeof fullChain>>;
  let B: Awaited<ReturnType<typeof fullChain>>;
  let consumer: { token: string; email: string };

  beforeAll(async () => {
    const email = `traveller-${Date.now()}@example.test`;
    consumer = { email, token: await consumerToken(email) };
    A = await fullChain(`ob-a-${Date.now()}`, consumer);
    B = await fullChain(`ob-b-${Date.now()}`, consumer);
  }, 120_000);

  it('suspend: logins blocked, live holds released, a paid customer still gets in, data kept; reactivate restores it', async () => {
    const before = await countsFor(A.tenantId);
    await ctl().post(`/admin/tenants/${A.tenantId}/suspend`).set(opAuth()).expect(200);
    app.get(TenantRegistry).invalidate();
    for (let i = 0; i < 50 && (await q(`SELECT 1 FROM seat_lock WHERE hold_id = $1`, [A.liveHold.hold_id])).length; i++) await new Promise((r) => setTimeout(r, 200));
    expect(await q(`SELECT 1 FROM seat_lock WHERE hold_id = $1`, [A.liveHold.hold_id])).toEqual([]);
    expect(await redis.exists(lockKey(A.tenantId, A.screeningId, A.seatIds[5]!))).toBe(0);

    // the chain admin is refused; the door staff can still scan what was sold
    const admins = await q<{ email: string }>(`SELECT email FROM staff_user WHERE tenant_id = $1 AND role = 'chain_admin'`, [A.tenantId]);
    expect((await staffLogin(A.slug, admins[0]!.email)).body.error).toBe('tenant_suspended');
    const door = await q<{ email: string }>(`SELECT email FROM staff_user WHERE tenant_id = $1 AND role = 'box_office'`, [A.tenantId]);
    const doorTok = (await staffLogin(A.slug, door[0]!.email).expect(200)).body.access_token;
    const scan = await api().post('/api/v1/tickets/redeem').set('authorization', `Bearer ${doorTok}`).send({ code: A.mine.tickets[0].code, screening_id: A.screeningId, device_id: 'gate' }).expect(200);
    expect(scan.body.result).toBe('valid');
    await api().get('/api/v1/theatres').set('authorization', `Bearer ${doorTok}`).expect(403); // nothing else
    await postHold(app, A.screeningId, [A.seatIds[6]!]).expect(404); // no new sales
    const after = await countsFor(A.tenantId);
    expect({ ...after, seat_lock: before.seat_lock, admission_event: before.admission_event }).toEqual(before); // only the live hold went (and the scan was added)

    await ctl().post(`/admin/tenants/${A.tenantId}/reactivate`).set(opAuth()).expect(200);
    app.get(TenantRegistry).invalidate();
    await staffLogin(A.slug, admins[0]!.email).expect(200);
  });

  it('a tampered export is caught BEFORE anything is deleted; the next attempt re-exports', async () => {
    const C = await fullChain(`ob-c-${Date.now()}`, consumer);
    const before = await countsFor(C.tenantId);
    await ctl().post(`/admin/tenants/${C.tenantId}/offboard`).set(opAuth()).expect(202);
    // wait for the export to land, then corrupt one file before the control plane verifies it
    const key = `t/${C.tenantId}/offboarding/export/ticket.jsonl`;
    for (let i = 0; i < 100; i++) {
      if ((await app.get(StorageService).listTenantKeys(C.tenantId)).includes(`t/${C.tenantId}/offboarding/export/manifest.json`)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await app.get(StorageService).putObject(C.tenantId, ['offboarding', 'export', 'ticket.jsonl'], Buffer.from('{"tampered":true}\n'), 'application/x-ndjson');
    const r = await ctl().post(`/admin/tenants/${C.tenantId}/offboard/advance`).set(opAuth());
    expect(r.status).toBeGreaterThanOrEqual(400);
    const status = (await ctl().get(`/admin/tenants/${C.tenantId}/offboard`).set(opAuth()).expect(200)).body;
    expect(status).toMatchObject({ status: 'offboarding', last_error: expect.stringContaining('does not verify') });
    expect(await countsFor(C.tenantId)).toEqual({ ...before, seat_lock: before.seat_lock! - 1 }); // nothing deleted (bar the released live hold)
    expect(key).toContain('ticket.jsonl');
    // resumable: the workflow re-exports and carries on to the end
    await advanceUntil(C.tenantId, 'deleted');
  });

  it('offboard: every tenant table emptied, Redis/queues/objects cleared, report signed — the consumer and other chains untouched', async () => {
    const before = await countsFor(A.tenantId);
    for (const t of TENANT_TABLES) expect(before[t], `${t} must hold data before offboarding, or "0 remaining" proves nothing`).toBeGreaterThan(0);
    const bBefore = await countsFor(B.tenantId);

    await ctl().post(`/admin/tenants/${A.tenantId}/offboard`).set(opAuth()).expect(202);
    await advanceUntil(A.tenantId, 'deleted');
    await ctl().post(`/admin/tenants/${A.tenantId}/offboard/advance`).set(opAuth()).expect(200); // repeatable once done

    const report = (await ctl().get(`/admin/tenants/${A.tenantId}/offboard/report`).set(opAuth()).expect(200)).body;
    // the plan's verify: `.tables[] | select(.remaining > 0)` is empty
    expect(report.tables.filter((t: { remaining: number }) => t.remaining > 0)).toEqual([]);
    expect(report.tables.map((t: { table: string }) => t.table).sort()).toEqual([...TENANT_TABLES].sort());
    // A's live hold already went when it was suspended (previous test), so `before` is exactly what was deleted.
    for (const t of report.tables) expect(t.before, t.table).toBe(before[t.table as string]);
    expect(report).toMatchObject({ complete: true, redis: { remaining: 0 }, queues: { remaining: 0 }, objects: { remaining_outside_export: 0 } });
    expect(report.export.tables).toBe(TENANT_TABLES.length);
    const verified = await control.get(DeletionReportSigner).verify(report.signature);
    expect(verified?.tenant_id).toBe(A.tenantId);

    // Independent checks, as the admin: not one row, key or object left.
    expect(Object.values(await countsFor(A.tenantId)).every((n) => n === 0)).toBe(true);
    let cursor = '0';
    let keys: string[] = [];
    do {
      const [next, page] = await redis.scan(cursor, 'MATCH', `*{t:${A.tenantId}*`, 'COUNT', 500);
      cursor = next;
      keys = keys.concat(page);
    } while (cursor !== '0');
    expect(keys).toEqual([]);
    const objects = await app.get(StorageService).listTenantKeys(A.tenantId);
    expect(objects.every((k) => k.startsWith(`t/${A.tenantId}/offboarding/export/`))).toBe(true);
    expect((await q<{ status: string }>(`SELECT status::text FROM tenant WHERE id = $1`, [A.tenantId]))[0]!.status).toBe('deleted');

    // The other chain: untouched. The consumer: untouched, and their OTHER chain's history still resolves.
    expect(await countsFor(B.tenantId)).toEqual(bBefore);
    expect((await q(`SELECT 1 FROM platform.consumer WHERE email = $1`, [consumer.email])).length).toBe(1);
    const relogin = (await api().post('/api/v1/auth/login').send({ email: consumer.email, password: 'consumer-password-1' }).expect(200)).body.access_token;
    const history = (await api().get('/api/v1/bookings').set('authorization', `Bearer ${relogin}`).expect(200)).body.items;
    expect(history.map((b: { booking_id: string }) => b.booking_id)).toEqual([B.mine.booking_id]);
  });
});
