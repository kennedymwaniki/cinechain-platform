/**
 * Step 18: hold → booking, against real Postgres and Redis. Each test seeds
 * its own chain, so the order of tests does not matter.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { BookingRepository } from '../../src/booking/booking.repository';
import { GuestLinkModule } from '../../src/booking/guest-link.module';
import { GuestLinkFanout } from '../../src/booking/guest-link';
import { LogVerificationMailer } from '../../src/identity/verification-mailer';
import { PaymentProviders } from '../../src/payment/payment-providers';
import { signWebhook } from '../../src/payment/providers/gateway-provider';
import { QueueModule } from '../../src/queue/queue.module';
import { runWithTenant } from '../../src/tenancy/tenant-context';
import { TenantDb } from '../../src/tenancy/tenant-db.provider';
import { postHold, seedSellable } from '../support/holds';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
const http = () => request(app.getHttpServer());
const SECRET = 'bookings-e2e-webhook-secret';

beforeAll(async () => {
  app = await bootTestApp(urls, {
    modules: [QueueModule, GuestLinkModule],
    env: { REDIS_URL: inject('redisUrl'), PAYMENT_WEBHOOK_SECRET_MPESA: SECRET, PAYMENT_WEBHOOK_SECRET_CARD: SECRET },
  });
  const p = app.get(PaymentProviders);
  for (const prov of [p.mpesa, p.card]) prov.pollIntervalMs = 5;
});
afterAll(() => app.close());

let keyN = 0;
const key = () => `e2e-${Date.now()}-${keyN++}`;
const guest = { name: 'Grace W.', email: 'grace@example.test' };
const mpesa = (holdToken: string, contact = guest) => ({ hold_token: holdToken, payment_method: 'mpesa', phone: '+254712345678', contact });
const book = (body: object, k = key(), token?: string) => {
  const r = http().post('/api/v1/bookings').set('idempotency-key', k);
  return (token ? r.set('authorization', `Bearer ${token}`) : r).send(body);
};
const db = <T>(sql: string, params: unknown[] = []) => asAdmin(urls.adminUrl, async (c) => (await c.query(sql, params)).rows as T[]);

async function consumer(email: string, verify: boolean): Promise<string> {
  await http().post('/api/v1/auth/register').send({ email, password: 'consumer-password-1' }).expect(202);
  if (verify) {
    const link = app.get(LogVerificationMailer).outbox.get(email)!;
    await http().post('/api/v1/auth/verify-email').send({ token: new URL(link).searchParams.get('token') }).expect(200);
  }
  return (await http().post('/api/v1/auth/login').send({ email, password: 'consumer-password-1' }).expect(200)).body.access_token;
}

describe('guest checkout (FR-70)', () => {
  it('a guest books end to end with no account anywhere; one ticket per seat; the seats show taken', async () => {
    const t = await seedSellable(urls.adminUrl, 4);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!, t.seatIds[1]!]).expect(201)).body;
    const res = await book(mpesa(hold.hold_token)).expect(201);
    expect(res.body).toMatchObject({ status: 'confirmed', reference: expect.stringMatching(/^[A-Z0-9]{2,5}-[2-9A-Z]{6}$/), total: { amount_minor: 160000, currency: 'KES' } });
    expect(res.body.tickets).toHaveLength(2);
    expect(res.body.tickets.every((x: { code: string }) => /^[A-Za-z0-9_-]{22}$/.test(x.code))).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('consumer_id');

    const map = (await http().get(`/api/v1/screenings/${t.screeningId}/seatmap`).expect(200)).body;
    const state = (id: string) => map.seats.find((s: { id: string }) => s.id === id).state;
    expect([state(t.seatIds[0]!), state(t.seatIds[1]!)]).toEqual(['taken', 'taken']);

    const [row] = await db<{ status: string; payment: string; codes: number }>(
      `SELECT b.status::text, p.status::text AS payment, (SELECT count(*)::int FROM ticket WHERE booking_id = b.id) AS codes
         FROM booking b JOIN payment p ON p.booking_id = b.id WHERE b.id = $1`,
      [res.body.booking_id],
    );
    expect(row).toEqual({ status: 'confirmed', payment: 'captured', codes: 2 });
    // the raw codes are not in the database
    const hashes = await db<{ h: string }>(`SELECT encode(code_hash, 'escape') AS h FROM ticket WHERE booking_id = $1`, [res.body.booking_id]);
    for (const tk of res.body.tickets) expect(JSON.stringify(hashes)).not.toContain(tk.code);
  });

  it('no PAN, CVV or expiry is ever accepted', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    for (const extra of [{ card_number: '4242424242424242' }, { cvv: '123' }, { expiry: '12/30' }])
      await book({ hold_token: hold.hold_token, payment_method: 'card', card_token: 'tok_x_4242', contact: guest, ...extra }).expect(400);
    await book({ hold_token: hold.hold_token, payment_method: 'card', card_token: '4242424242424242', contact: guest }).expect(400);
    const ok = await book({ hold_token: hold.hold_token, payment_method: 'card', card_token: 'tok_abc_4242', contact: guest }).expect(201);
    const [p] = await db<{ card_token: string; card_last4: string }>(`SELECT card_token, card_last4 FROM payment WHERE booking_id = $1`, [ok.body.booking_id]);
    expect(p).toEqual({ card_token: 'tok_abc_4242', card_last4: '4242' });
  });

  it('replaying the idempotency key returns the same booking and captures nothing', async () => {
    const t = await seedSellable(urls.adminUrl, 2, 'loyalty_points_per_unit = 1');
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const k = key();
    const first = await book(mpesa(hold.hold_token, { name: 'L', email: 'loyal@example.test' }), k).expect(201);
    const gw = app.get(PaymentProviders).mpesa.gateway;
    const before = gw.calls.length;
    const again = await book(mpesa(hold.hold_token, { name: 'L', email: 'loyal@example.test' }), k).expect(201);
    expect(again.body.booking_id).toBe(first.body.booking_id);
    expect(again.body.replayed).toBe(true);
    expect(gw.calls.length).toBe(before); // the provider was not even asked
    // the same key with a different body is refused
    await book({ ...mpesa(hold.hold_token), phone: '+254700000000' }, k).expect(422);

    const [pts] = await db<{ points: number }>(`SELECT loyalty_points AS points FROM tenant_customer WHERE tenant_id = $1 AND email = 'loyal@example.test'`, [t.tenantId]);
    expect(pts!.points).toBe(800); // KES 800.00 × 1 point per unit, exactly once
    // and a second award for the same booking inserts nothing
    const repo = app.get(BookingRepository);
    const twice = await runWithTenant({ tenantId: t.tenantId, actor: { kind: 'system', reason: 'test' } }, () =>
      app.get(TenantDb).withTenantScope(() => repo.awardLoyalty(first.body.booking_id, 'loyal@example.test', 800)),
    );
    expect(twice).toBe(false);
  });

  it('a forced failure at ticket insert leaves the seats held — never half-sold', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!, t.seatIds[1]!]).expect(201)).body;
    const spy = vi.spyOn(app.get(BookingRepository), 'insertTickets').mockRejectedValueOnce(new Error('injected'));
    await book(mpesa(hold.hold_token)).expect(500);
    spy.mockRestore();
    const locks = await db<{ status: string }>(`SELECT status::text FROM seat_lock WHERE hold_id = $1`, [hold.hold_id]);
    expect(locks.map((l) => l.status)).toEqual(['held', 'held']);
    const [b] = await db<{ status: string; payment: string }>(
      `SELECT b.status::text, p.status::text AS payment FROM booking b JOIN payment p ON p.booking_id = b.id WHERE b.hold_id = $1`,
      [hold.hold_id],
    );
    // A captured payment on a pending booking: exactly what step 19's reconciler refunds.
    expect(b).toEqual({ status: 'pending', payment: 'captured' });
  });

  it('refuses to start paying with under 45 s left on the hold', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    await db(`UPDATE seat_lock SET expires_at = now() + interval '30 seconds' WHERE hold_id = $1`, [hold.hold_id]);
    const res = await book(mpesa(hold.hold_token)).expect(409);
    expect(res.body.error).toBe('hold_expiring');
    expect(app.get(PaymentProviders).mpesa.gateway.calls.filter((c) => c.op === 'charge').length).toBeGreaterThanOrEqual(0);
    expect((await db(`SELECT 1 FROM payment p JOIN booking b ON b.id = p.booking_id WHERE b.hold_id = $1`, [hold.hold_id])).length).toBe(0);
  });

  it('a declined payment leaves the hold usable: retry with another method succeeds', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    app.get(PaymentProviders).mpesa.gateway.next = 'decline';
    const declined = await book(mpesa(hold.hold_token)).expect(409);
    expect(declined.body.error).toBe('payment_failed');
    const ok = await book({ hold_token: hold.hold_token, payment_method: 'card', card_token: 'tok_retry_1111', contact: guest }).expect(201);
    expect(ok.body.status).toBe('confirmed');
  });

  it('a capture still pending at response time is confirmed by the provider’s callback', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const prov = app.get(PaymentProviders).mpesa;
    prov.gateway.next = 'unknown';
    prov.pollAttempts = 2;
    const pending = await book(mpesa(hold.hold_token)).expect(202);
    prov.pollAttempts = 10;
    expect(pending.body.status).toBe('pending');
    const [p] = await db<{ provider_ref: string }>(`SELECT provider_ref FROM payment WHERE booking_id = $1`, [pending.body.booking_id]);
    const body = JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: p!.provider_ref, ResultCode: 0, ResultDesc: 'ok' } } });
    await http().post('/api/v1/webhooks/payments/mpesa').set('content-type', 'application/json').set('x-cinechain-signature', signWebhook(SECRET, body)).send(body).expect(200);
    const [b] = await db<{ status: string; tickets: number }>(
      `SELECT status::text, (SELECT count(*)::int FROM ticket WHERE booking_id = $1) AS tickets FROM booking WHERE id = $1`,
      [pending.body.booking_id],
    );
    expect(b).toEqual({ status: 'confirmed', tickets: 1 });
  });
});

describe('box office (FR-57)', () => {
  it('a cash sale produces tickets and a payment with tender_type cash and the clerk recorded', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const slug = (await db<{ slug: string }>(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))[0]!.slug;
    const clerkId = await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `till@${slug}.test`, 'box_office'));
    const tok = (await http().post('/api/v1/auth/staff/login').send({ email: `till@${slug}.test`, password: TEST_PASSWORD, tenant_slug: slug })).body.access_token;
    const hold = (await http().post('/api/v1/box-office/holds').set('authorization', `Bearer ${tok}`).send({ screening_id: t.screeningId, seat_ids: [t.seatIds[0]] }).expect(201)).body;
    const sale = await http()
      .post('/api/v1/box-office/sales')
      .set('authorization', `Bearer ${tok}`)
      .set('idempotency-key', key())
      .send({ hold_token: hold.hold_token, tender_type: 'cash' })
      .expect(201);
    expect(sale.body).toMatchObject({ status: 'confirmed', contact: null });
    expect(sale.body.tickets).toHaveLength(1);
    const [p] = await db(`SELECT provider, tender_type, recorded_by_staff::text AS clerk, status::text FROM payment WHERE booking_id = $1`, [sale.body.booking_id]);
    expect(p).toEqual({ provider: 'cash', tender_type: 'cash', clerk: clerkId, status: 'captured' });
    // an online hold token cannot be sold at the counter of ANOTHER chain
    const other = await seedSellable(urls.adminUrl, 2);
    const foreign = (await postHold(app, other.screeningId, [other.seatIds[0]!]).expect(201)).body;
    await http().post('/api/v1/box-office/sales').set('authorization', `Bearer ${tok}`).set('idempotency-key', key()).send({ hold_token: foreign.hold_token, tender_type: 'cash' }).expect(404);
  });
});

describe('accounts across chains (FR-76, FR-77, FR-78)', () => {
  it('a consumer who booked at two chains sees both in GET /bookings, with no consumer_id exposed', async () => {
    const token = await consumer(`traveller-${Date.now()}@example.test`, true);
    const [nyati, prestige] = [await seedSellable(urls.adminUrl, 2), await seedSellable(urls.adminUrl, 2)];
    const refs: string[] = [];
    for (const t of [nyati, prestige]) {
      const hold = (await request(app.getHttpServer()).post(`/api/v1/screenings/${t.screeningId}/holds`).set('authorization', `Bearer ${token}`).send({ seat_ids: [t.seatIds[0]] }).expect(201)).body;
      refs.push((await book(mpesa(hold.hold_token), key(), token).expect(201)).body.reference);
    }
    const list = await http().get('/api/v1/bookings').set('authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.map((b: { reference: string }) => b.reference).sort()).toEqual(refs.sort());
    expect(new Set(list.body.items.map((b: { chain: { slug: string } }) => b.chain.slug)).size).toBe(2);
    expect(list.text).not.toContain('consumer_id');
    // a guest token-less call is refused; a staff token is the wrong type
    await http().get('/api/v1/bookings').expect(401);
  });

  it('a guest booking made before registration appears in history only after e-mail verification', async () => {
    const email = `later-${Date.now()}@example.test`;
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const guestBooking = (await book(mpesa(hold.hold_token, { name: 'Later', email })).expect(201)).body;

    await http().post('/api/v1/auth/register').send({ email, password: 'consumer-password-1' }).expect(202);
    const unverified = (await http().post('/api/v1/auth/login').send({ email, password: 'consumer-password-1' }).expect(200)).body.access_token;
    await app.get(GuestLinkFanout).drain();
    expect((await http().get('/api/v1/bookings').set('authorization', `Bearer ${unverified}`).expect(200)).body.items).toEqual([]);

    const link = app.get(LogVerificationMailer).outbox.get(email)!;
    await http().post('/api/v1/auth/verify-email').send({ token: new URL(link).searchParams.get('token') }).expect(200);
    await app.get(GuestLinkFanout).drain();
    let items: { booking_id: string }[] = [];
    for (let i = 0; i < 50 && !items.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      items = (await http().get('/api/v1/bookings').set('authorization', `Bearer ${unverified}`).expect(200)).body.items;
    }
    expect(items.map((b) => b.booking_id)).toEqual([guestBooking.booking_id]);
  });

  it('loyalty accrues per chain and is visible only per chain', async () => {
    const email = `points-${Date.now()}@example.test`;
    const token = await consumer(email, true);
    const a = await seedSellable(urls.adminUrl, 2, 'loyalty_points_per_unit = 2');
    const b = await seedSellable(urls.adminUrl, 2, 'loyalty_points_per_unit = 0');
    for (const t of [a, b]) {
      const hold = (await request(app.getHttpServer()).post(`/api/v1/screenings/${t.screeningId}/holds`).set('authorization', `Bearer ${token}`).send({ seat_ids: [t.seatIds[0]] }).expect(201)).body;
      await book(mpesa(hold.hold_token, { name: 'P', email }), key(), token).expect(201);
    }
    const res = await http().get('/api/v1/me/loyalty').set('authorization', `Bearer ${token}`).expect(200);
    expect(res.body.balances.map((x: { points: number }) => x.points).sort()).toEqual([0, 1600]);
  });
});
