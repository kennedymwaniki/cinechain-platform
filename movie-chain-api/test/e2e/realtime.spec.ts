/**
 * Step 21: the live seat map and notifications, over real Socket.IO with the
 * Redis adapter, against real Postgres and Redis.
 */
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { HoldService } from '../../src/inventory/hold.service';
import { LogNotifier } from '../../src/notification/notifier';
import { NotificationModule } from '../../src/notification/notification.module';
import { QueueModule } from '../../src/queue/queue.module';
import { RealtimeModule } from '../../src/realtime/realtime.module';
import { toSystemContext } from '../../src/tenancy/system-context';
import { listen, postHold, seedSellable } from '../support/holds';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let node1: INestApplication;
let node2: INestApplication;
let base1: string;
let base2: string;
const sockets: Socket[] = [];

const boot = () =>
  bootTestApp(urls, { modules: [QueueModule, RealtimeModule, NotificationModule], env: { REDIS_URL: inject('redisUrl') }, websockets: true });

beforeAll(async () => {
  [node1, node2] = [await boot(), await boot()];
  [base1, base2] = [await listen(node1), await listen(node2)];
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await Promise.all([node1.close(), node2.close()]);
});

function connect(base: string, token?: string): Promise<Socket> {
  const s = io(`${base}/seatmap`, { transports: ['websocket'], auth: token ? { token } : {}, forceNew: true });
  sockets.push(s);
  return new Promise((ok, fail) => {
    s.once('connect', () => ok(s));
    s.once('connect_error', fail);
  });
}
const ask = <T>(s: Socket, event: string, body: object, reply: string) =>
  new Promise<T>((ok) => {
    s.once(reply, ok);
    s.emit(event, body);
  });
/** Everything a socket receives, by event name. */
function record(s: Socket) {
  const got: { event: string; data: Record<string, unknown> }[] = [];
  s.onAny((event: string, data: Record<string, unknown>) => got.push({ event, data }));
  return got;
}
const until = async (cond: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 20));
};

describe('live seat map', () => {
  it('a guest subscribed by SCREENING id sees holds, releases and sales — payloads carry no hold or tenant id', async () => {
    const t = await seedSellable(urls.adminUrl, 4);
    const s = await connect(base1);
    const sub = await ask<{ screening_id: string; version: number }>(s, 'subscribe', { screening_id: t.screeningId }, 'subscribed');
    expect(sub.screening_id).toBe(t.screeningId);
    const got = record(s);

    const hold = (await postHold(node1, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    await request(node1.getHttpServer()).delete(`/api/v1/holds/${hold.hold_id}`).set('hold-token', hold.hold_token).expect(204);
    const h2 = (await postHold(node1, t.screeningId, [t.seatIds[1]!]).expect(201)).body;
    await request(node1.getHttpServer())
      .post('/api/v1/bookings')
      .set('idempotency-key', `rt-${crypto.randomUUID()}`)
      .send({ hold_token: h2.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'R', email: 'rt@example.test' } })
      .expect(201);
    await until(() => got.length >= 4);

    expect(got.map((g) => g.event)).toEqual(['seats:taken', 'seats:released', 'seats:taken', 'seats:taken']);
    for (const g of got) {
      expect(Object.keys(g.data).sort()).toEqual(['at', 'screeningId', 'seatIds', 'version']);
      expect(JSON.stringify(g.data)).not.toContain(t.tenantId);
      expect(JSON.stringify(g.data)).not.toMatch(new RegExp(`${hold.hold_id}|${h2.hold_id}`));
    }
    const versions = got.map((g) => g.data.version as number);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions); // monotonic: a client can spot a gap
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('a client cannot name a room: joining by room name, or subscribing to an unpublished screening, yields nothing', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const s = await connect(base1);
    const got = record(s);
    s.emit('join', { room: `t:${t.tenantId}:scr:${t.screeningId}` });
    s.emit('subscribe', { room: `t:${t.tenantId}:scr:${t.screeningId}` });
    await new Promise((r) => setTimeout(r, 200));
    await postHold(node1, t.screeningId, [t.seatIds[0]!]).expect(201);
    await new Promise((r) => setTimeout(r, 500));
    expect(got.filter((g) => g.event.startsWith('seats:'))).toEqual([]);
    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE screening SET status = 'draft' WHERE id = $1`, [t.screeningId]));
    expect(await ask(s, 'subscribe', { screening_id: t.screeningId }, 'subscribe_error')).toEqual({ error: 'not_found' });
  });

  it('a token carrying a tenant (staff) is refused at connection: wrong_token_type', async () => {
    const t = await seedSellable(urls.adminUrl, 1);
    const slug = (await asAdmin(urls.adminUrl, (c) => c.query(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))).rows[0].slug;
    await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `ws@${slug}.test`, 'box_office'));
    const tok = (await request(node1.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: `ws@${slug}.test`, password: TEST_PASSWORD, tenant_slug: slug })).body.access_token;
    const s = io(`${base1}/seatmap`, { transports: ['websocket'], auth: { token: tok }, forceNew: true });
    sockets.push(s);
    const err = await new Promise((ok) => s.once('error', ok));
    expect(err).toEqual({ error: 'wrong_token_type' });
    await until(() => !s.connected);
    expect(s.connected).toBe(false);
  });

  it('the private hold room: joined by presenting the token; countdown events carry the server’s expires_at', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = await node1.get(HoldService).place({
      ctx: toSystemContext({ tenantId: t.tenantId }, { kind: 'guest' }),
      screeningId: t.screeningId,
      seatIds: [t.seatIds[0]!],
      ttlSeconds: 2,
      channel: 'online',
      heldByStaff: null,
    });
    const s = await connect(base1);
    await ask(s, 'subscribe', { screening_id: t.screeningId }, 'subscribed');
    expect(await ask(s, 'watch_hold', { hold_token: 'forged' }, 'watch_hold_error')).toEqual({ error: 'hold_token_invalid' });
    await ask(s, 'watch_hold', { hold_token: hold.hold_token }, 'watching_hold');
    const got = record(s);
    await until(() => got.some((g) => g.event === 'hold:expired'), 8000);
    await until(() => got.some((g) => g.event === 'seats:released'), 3000);
    const expired = got.find((g) => g.event === 'hold:expired')!;
    expect(expired.data.expires_at).toBe(hold.expires_at);
    expect(got.find((g) => g.event === 'seats:released')!.data.seatIds).toEqual([t.seatIds[0]]);
  });

  it('two API instances, one Redis: an event raised on node 2 reaches a client on node 1', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const s = await connect(base1);
    await ask(s, 'subscribe', { screening_id: t.screeningId }, 'subscribed');
    const got = record(s);
    await postHold(node2, t.screeningId, [t.seatIds[0]!]).expect(201);
    await until(() => got.length > 0);
    expect(got.map((g) => g.event)).toEqual(['seats:taken']);
    expect(base1).not.toBe(base2);
  });
});

describe('notifications (FR-55)', () => {
  it('tickets go out by e-mail and SMS; a delivery failure retries and never touches the booking', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const notifier = node1.get(LogNotifier);
    const notifier2 = node2.get(LogNotifier);
    notifier.failNext = 1;
    notifier2.failNext = 1;
    const hold = (await postHold(node1, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const email = `note-${Date.now()}@example.test`;
    const booking = (
      await request(node1.getHttpServer())
        .post('/api/v1/bookings')
        .set('idempotency-key', `nt-${crypto.randomUUID()}`)
        .send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'N', email } })
        .expect(201)
    ).body;
    const all = () => [...notifier.sent, ...notifier2.sent];
    await until(() => all().some((m) => m.to === email), 30_000);
    const mail = all().find((m) => m.to === email)!;
    expect(mail.text).toContain(booking.tickets[0].code);
    expect(all().some((m) => m.channel === 'sms' && m.to === '+254712345678' && m.text.includes(booking.reference))).toBe(true);
    const [row] = (await asAdmin(urls.adminUrl, (c) => c.query(`SELECT status::text FROM booking WHERE id = $1`, [booking.booking_id]))).rows;
    expect(row.status).toBe('confirmed');
  });
});
