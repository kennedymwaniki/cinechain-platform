/** Step 19: nobody is charged for a seat they do not receive, and nobody has to ask for the refund. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Reconciler } from '../../src/booking/reconciliation.processor';
import { PaymentProviders } from '../../src/payment/payment-providers';
import { postHold, seedSellable } from '../support/holds';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
const http = () => request(app.getHttpServer());
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await asAdmin(urls.adminUrl, (c) => c.query(sql, p))).rows as T[];
let n = 0;

beforeAll(async () => {
  app = await bootTestApp(urls, { env: { REDIS_URL: inject('redisUrl') } });
  app.get(PaymentProviders).mpesa.pollIntervalMs = 5;
});
afterAll(() => app.close());

async function bought(t: Awaited<ReturnType<typeof seedSellable>>, seats: string[], email = 'buyer@example.test') {
  const hold = (await postHold(app, t.screeningId, seats).expect(201)).body;
  return (
    await http()
      .post('/api/v1/bookings')
      .set('idempotency-key', `rf-${Date.now()}-${n++}`)
      .send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'B', email } })
      .expect(201)
  ).body as { booking_id: string; manage_token: string; reference: string };
}
const cancel = (b: { booking_id: string; manage_token: string }, body: object = {}) =>
  http().post(`/api/v1/bookings/${b.booking_id}/cancel`).set('booking-token', b.manage_token).send(body);
const refunded = async (bookingId: string) =>
  (await q<{ s: number }>(`SELECT coalesce(sum(r.amount_minor), 0)::int AS s FROM payment_refund r JOIN payment p ON p.id = r.payment_id WHERE p.booking_id = $1 AND r.status <> 'failed'`, [bookingId]))[0]!.s;

describe('customer cancellation (FR-62–64)', () => {
  it('cancelling the whole booking refunds it, voids the tickets and puts the seats back on sale at once', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const b = await bought(t, [t.seatIds[0]!, t.seatIds[1]!]);
    const res = await cancel(b).expect(201);
    expect(res.body).toMatchObject({ status: 'cancelled', refund: { status: 'succeeded', amount: { amount_minor: 160000 } } });
    expect(await q(`SELECT status FROM ticket WHERE booking_id = $1`, [b.booking_id])).toEqual([{ status: 'void' }, { status: 'void' }]);
    await postHold(app, t.screeningId, [t.seatIds[0]!, t.seatIds[1]!]).expect(201); // FR-63
  });

  it('partial cancellation refunds that seat only; the second part completes it; never more than captured', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const b = await bought(t, [t.seatIds[0]!, t.seatIds[1]!]);
    const one = await cancel(b, { seat_ids: [t.seatIds[0]] }).expect(201);
    expect(one.body).toMatchObject({ status: 'confirmed', cancelled_seat_ids: [t.seatIds[0]], refund: { amount: { amount_minor: 80000 } } });
    await cancel(b, { seat_ids: [t.seatIds[0]] }).expect(201); // repeat: nothing more
    expect(await refunded(b.booking_id)).toBe(80000);
    const two = await cancel(b).expect(201);
    expect(two.body.status).toBe('cancelled');
    expect(await refunded(b.booking_id)).toBe(160000);
    await cancel(b).expect(201);
    expect(await refunded(b.booking_id)).toBe(160000);
  });

  it('outside the chain’s window (default 2 h before the start) it is refused', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    await q(`UPDATE screening SET starts_at = now() + interval '90 minutes', ends_at = now() + interval '210 minutes' WHERE id = $1`, [t.screeningId]);
    const b = await bought(t, [t.seatIds[0]!]);
    const res = await cancel(b).expect(409);
    expect(res.body).toMatchObject({ error: 'cancellation_window_closed', window_minutes: 120 });
  });

  it('the link works for ITS booking only', async () => {
    const t = await seedSellable(urls.adminUrl, 3);
    const a = await bought(t, [t.seatIds[0]!]);
    const b = await bought(t, [t.seatIds[1]!]);
    await http().post(`/api/v1/bookings/${a.booking_id}/cancel`).set('booking-token', b.manage_token).send({}).expect(401);
    await http().post(`/api/v1/bookings/${a.booking_id}/cancel`).send({}).expect(401);
  });

  it('a refund takes back its share of loyalty points, never below zero; the shortfall is recorded', async () => {
    const t = await seedSellable(urls.adminUrl, 3, 'loyalty_points_per_unit = 1');
    const b = await bought(t, [t.seatIds[0]!, t.seatIds[1]!], 'spender@example.test'); // 1600 points
    await q(`UPDATE tenant_customer SET loyalty_points = 100 WHERE tenant_id = $1 AND email = 'spender@example.test'`, [t.tenantId]); // spent 1500
    await cancel(b, { seat_ids: [t.seatIds[0]] }).expect(201); // half the money → 800 points due back
    const [c] = await q<{ points: number }>(`SELECT loyalty_points AS points FROM tenant_customer WHERE tenant_id = $1 AND email = 'spender@example.test'`, [t.tenantId]);
    expect(c!.points).toBe(0);
    const [rev] = await q(`SELECT points, shortfall FROM loyalty_ledger WHERE booking_id = $1 AND kind = 'reversal'`, [b.booking_id]);
    expect(rev).toEqual({ points: -100, shortfall: 700 });
  });
});

describe('screening cancellation (FR-26)', () => {
  it('releases live holds, refunds every booking, and cancelling twice refunds nothing twice', async () => {
    const t = await seedSellable(urls.adminUrl, 4);
    const slug = (await q<{ slug: string }>(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))[0]!.slug;
    await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `mgr@${slug}.test`, 'chain_admin'));
    const tok = (await http().post('/api/v1/auth/staff/login').send({ email: `mgr@${slug}.test`, password: TEST_PASSWORD, tenant_slug: slug })).body.access_token;

    const b1 = await bought(t, [t.seatIds[0]!]);
    const b2 = await bought(t, [t.seatIds[1]!, t.seatIds[2]!]);
    await postHold(app, t.screeningId, [t.seatIds[3]!]).expect(201);

    const first = await http().post(`/api/v1/screenings/${t.screeningId}/cancel`).set('authorization', `Bearer ${tok}`).expect(200);
    expect(first.body).toMatchObject({ status: 'cancelled', released_holds: 1, cancelled_bookings: 2, refunds: { count: 2, succeeded: 2 } });
    const again = await http().post(`/api/v1/screenings/${t.screeningId}/cancel`).set('authorization', `Bearer ${tok}`).expect(200);
    expect(again.body.refunds).toEqual({ count: 0, succeeded: 0 });

    expect([await refunded(b1.booking_id), await refunded(b2.booking_id)]).toEqual([80000, 160000]);
    expect(await q(`SELECT count(*)::int AS n FROM payment_refund r JOIN payment p ON p.id = r.payment_id JOIN booking b ON b.id = p.booking_id WHERE b.screening_id = $1`, [t.screeningId])).toEqual([{ n: 2 }]);
    expect(await q(`SELECT count(*)::int AS n FROM seat_lock WHERE screening_id = $1`, [t.screeningId])).toEqual([{ n: 0 }]);
    expect(await q(`SELECT DISTINCT status::text FROM booking WHERE screening_id = $1`, [t.screeningId])).toEqual([{ status: 'cancelled' }]);
    // and the screening is off sale
    await postHold(app, t.screeningId, [t.seatIds[3]!]).expect(404);
  });
});

describe('reconciliation', () => {
  it('a capture whose booking never confirmed (crash after capture) is refunded in full', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const [bk] = await q<{ id: string }>(
      `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, channel, guest_email, guest_name, seat_ids, total_minor, currency, created_at)
       VALUES ($1, 'ORPH-1', $2, gen_random_uuid(), 'online', 'o@example.test', 'O', ARRAY[$3::uuid], 80000, 'KES', now() - interval '10 minutes') RETURNING id`,
      [t.tenantId, t.screeningId, t.seatIds[0]],
    );
    const capture = await app.get(PaymentProviders).mpesa.capture({
      idempotencyKey: bk!.id,
      amount: { amountMinor: 80000, currency: 'KES' },
      method: { kind: 'mpesa', phone: '+254712345678' },
      description: 'orphan',
    });
    await q(
      `INSERT INTO payment (tenant_id, booking_id, provider, provider_ref, idempotency_key, status, amount_minor, currency, captured_at)
       VALUES ($1, $2, 'mpesa', $3, $4, 'captured', 80000, 'KES', now())`,
      [t.tenantId, bk!.id, (capture as { providerRef: string }).providerRef, bk!.id],
    );
    const r = await app.get(Reconciler).reconcile(t.tenantId);
    expect(r.orphansRefunded).toBe(1);
    expect(await refunded(bk!.id)).toBe(80000);
    expect((await q(`SELECT status::text, failure_reason FROM booking WHERE id = $1`, [bk!.id]))[0]).toEqual({ status: 'expired', failure_reason: 'orphaned_capture' });
    // running again finds nothing to do
    expect((await app.get(Reconciler).reconcile(t.tenantId)).orphansRefunded).toBe(0);
  });

  it('a payment still pending at the provider is resolved by asking, never by charging again', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const [bk] = await q<{ id: string }>(
      `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, channel, guest_email, guest_name, seat_ids, total_minor, currency, created_at)
       VALUES ($1, 'PEND-1', $2, gen_random_uuid(), 'online', 'p@example.test', 'P', ARRAY[$3::uuid], 80000, 'KES', now() - interval '10 minutes') RETURNING id`,
      [t.tenantId, t.screeningId, t.seatIds[0]],
    );
    await q(`INSERT INTO payment (tenant_id, booking_id, provider, idempotency_key, amount_minor, currency) VALUES ($1, $2, 'mpesa', $3, 80000, 'KES')`, [t.tenantId, bk!.id, bk!.id]);
    const gw = app.get(PaymentProviders).mpesa.gateway;
    const charges = gw.calls.filter((c) => c.op === 'charge').length;
    await app.get(Reconciler).reconcile(t.tenantId);
    expect(gw.calls.filter((c) => c.op === 'charge').length).toBe(charges);
    expect((await q(`SELECT status::text FROM booking WHERE id = $1`, [bk!.id]))[0]).toEqual({ status: 'expired' });
  });
});
