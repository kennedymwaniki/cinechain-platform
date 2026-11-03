/**
 * FR-53, the most important failure path: the capture succeeds, but the hold
 * expires (and someone else takes a seat) before the seats can be sold.
 */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { lockKey } from '../../src/inventory/redis-locks';
import { Metrics } from '../../src/observability/metrics.module';
import { PaymentProviders } from '../../src/payment/payment-providers';
import { bootBookingApp, postHold, seedSellable } from '../support/holds';
import { asAdmin } from '../support/seed';

const urls = inject('db');
let app: INestApplication;

beforeAll(async () => {
  app = await bootBookingApp(urls, inject('redisUrl'));
});
afterAll(() => app.close());

describe('payment after expiry', () => {
  it('hold expires between capture and conversion: refund recorded, booking expired, 402, metric +1 exactly', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    const mpesa = app.get(PaymentProviders).mpesa;
    const realCapture = mpesa.capture.bind(mpesa);
    // The customer takes ~20 s on their handset; meanwhile the hold dies and a stranger buys the seat.
    vi.spyOn(mpesa, 'capture').mockImplementationOnce(async (req) => {
      const result = await realCapture(req);
      // The hold expires as it really would: the Redis key's TTL runs out, and so does the durable row.
      const r = new Redis(inject('redisUrl'));
      await r.del(lockKey(t.tenantId, t.screeningId, t.seatIds[0]!));
      r.disconnect();
      await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE seat_lock SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [hold.hold_id]));
      await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201);
      return result;
    });
    const metrics = app.get(Metrics);
    const before = metrics.get('booking.seats_lost_after_capture', { tenant: t.tenantId });

    const res = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('idempotency-key', `expiry-${Date.now()}`)
      .send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'Late', email: 'late@example.test' } })
      .expect(402);

    expect(res.body).toMatchObject({
      error: 'seats_lost_payment_refunded',
      unavailable_seat_ids: [t.seatIds[0]],
      refund: { status: 'succeeded', amount: { amount_minor: 80000, currency: 'KES' } },
    });
    expect(metrics.get('booking.seats_lost_after_capture', { tenant: t.tenantId }) - before).toBe(1);
    const [row] = (
      await asAdmin(urls.adminUrl, (c) =>
        c.query(
          `SELECT b.status::text AS booking, b.failure_reason, p.status::text AS payment,
                  (SELECT sum(amount_minor)::int FROM payment_refund r WHERE r.payment_id = p.id AND r.status = 'succeeded') AS refunded,
                  (SELECT count(*)::int FROM ticket WHERE booking_id = b.id) AS tickets
             FROM booking b JOIN payment p ON p.booking_id = b.id WHERE b.hold_id = $1`,
          [hold.hold_id],
        ),
      )
    ).rows;
    expect(row).toEqual({ booking: 'expired', failure_reason: 'seats_lost_after_capture', payment: 'captured', refunded: 80000, tickets: 0 });
  });

  it('capture is never attempted with under 45 s remaining', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201)).body;
    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE seat_lock SET expires_at = now() + interval '44 seconds' WHERE hold_id = $1`, [hold.hold_id]));
    const spy = vi.spyOn(app.get(PaymentProviders).mpesa, 'capture');
    const res = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('idempotency-key', `short-${Date.now()}`)
      .send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'S', email: 's@example.test' } })
      .expect(409);
    expect(res.body.error).toBe('hold_expiring');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
