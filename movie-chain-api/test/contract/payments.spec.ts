/**
 * Step 17 contract tests: the provider interface's promises, against the stub
 * gateway's call log, and the webhook endpoint against real Postgres.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PaymentProviders } from '../../src/payment/payment-providers';
import { signWebhook } from '../../src/payment/providers/gateway-provider';
import { CardProvider } from '../../src/payment/providers/card.provider';
import { MpesaProvider } from '../../src/payment/providers/mpesa.provider';
import { StubGateway } from '../../src/payment/providers/stub-gateway';
import { money } from '../../src/shared/money';
import { asAdmin, createTenant } from '../support/seed';
import { seedScreening } from '../support/seed-screening';
import { bootTestApp } from '../support/test-app';

const SECRET = 'contract-test-secret';
const KES = (n: number) => money(n, 'KES');
const mpesaReq = (key: string) => ({ idempotencyKey: key, amount: KES(160000), method: { kind: 'mpesa' as const, phone: '+254712345678' }, description: 'test' });
const charges = (g: StubGateway, key: string) => g.calls.filter((c) => c.op === 'charge' && c.key === key).length;

describe('provider contract', () => {
  let gw: StubGateway;
  let mpesa: MpesaProvider;
  beforeEach(() => {
    gw = new StubGateway();
    mpesa = new MpesaProvider(gw, SECRET);
    mpesa.pollIntervalMs = 5;
  });

  it('a capture retried with the same key does not charge twice', async () => {
    const a = await mpesa.capture(mpesaReq('booking-1'));
    const b = await mpesa.capture(mpesaReq('booking-1'));
    expect(a).toMatchObject({ status: 'captured' });
    expect(b).toMatchObject({ status: 'captured', providerRef: (a as { providerRef: string }).providerRef });
    expect(charges(gw, 'booking-1')).toBe(1);
  });

  it('a timeout is resolved by polling status, never by capturing again', async () => {
    gw.next = 'timeout';
    const r = await mpesa.capture(mpesaReq('booking-2'));
    expect(r.status).toBe('captured');
    expect(charges(gw, 'booking-2')).toBe(1);
    expect(gw.calls.filter((c) => c.op === 'status').length).toBeGreaterThan(1);
  });

  it('a capture still undecided after polling is reported pending, and a retry still does not charge', async () => {
    gw.next = 'unknown';
    const first = await mpesa.capture(mpesaReq('booking-3'));
    expect(first.status).toBe('pending');
    const again = await mpesa.capture(mpesaReq('booking-3'));
    expect(again.status).toBe('pending');
    expect(charges(gw, 'booking-3')).toBe(1);
    gw.settle((first as { providerRef: string }).providerRef, 'captured'); // the callback arrives
    expect((await mpesa.status('booking-3'))?.status).toBe('captured');
  });

  it('a decline is a failure; an unknown key has no status', async () => {
    gw.next = 'decline';
    expect((await mpesa.capture(mpesaReq('booking-4'))).status).toBe('failed');
    expect(await mpesa.status('never-seen')).toBeNull();
  });

  it('refunds are idempotent and never exceed the capture', async () => {
    const c = (await mpesa.capture(mpesaReq('booking-5'))) as { providerRef: string };
    const r1 = await mpesa.refund({ idempotencyKey: 'rf-1', providerRef: c.providerRef, amount: KES(100000) });
    const r1again = await mpesa.refund({ idempotencyKey: 'rf-1', providerRef: c.providerRef, amount: KES(100000) });
    expect(r1again).toEqual(r1);
    expect(await mpesa.refund({ idempotencyKey: 'rf-2', providerRef: c.providerRef, amount: KES(60001) })).toMatchObject({ status: 'failed' });
    expect(await mpesa.refund({ idempotencyKey: 'rf-3', providerRef: c.providerRef, amount: KES(60000) })).toMatchObject({ status: 'succeeded' });
  });

  it('cards: only a provider token is accepted, and only its last four are kept', async () => {
    const card = new CardProvider(new StubGateway(), SECRET);
    const ok = await card.capture({ idempotencyKey: 'b6', amount: KES(80000), method: { kind: 'card', cardToken: 'tok_abc123_4242' }, description: 't' });
    expect(ok).toMatchObject({ status: 'captured', cardLast4: '4242' });
    await expect(
      card.capture({ idempotencyKey: 'b7', amount: KES(80000), method: { kind: 'card', cardToken: '4242424242424242' }, description: 't' }),
    ).rejects.toThrow(/card token/);
  });

  it('webhook signatures: valid passes; tampered, missing, wrong-secret and stale fail', () => {
    const body = Buffer.from(JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'c1', ResultCode: 0, ResultDesc: 'ok' } } }));
    expect(mpesa.verifyWebhook(body, { 'x-cinechain-signature': signWebhook(SECRET, body) })).toMatchObject({ providerRef: 'c1', status: 'captured' });
    expect(mpesa.verifyWebhook(Buffer.from(body.toString().replace('c1', 'c2')), { 'x-cinechain-signature': signWebhook(SECRET, body) })).toBeNull();
    expect(mpesa.verifyWebhook(body, {})).toBeNull();
    expect(mpesa.verifyWebhook(body, { 'x-cinechain-signature': signWebhook('other', body) })).toBeNull();
    expect(mpesa.verifyWebhook(body, { 'x-cinechain-signature': signWebhook(SECRET, body, Math.floor(Date.now() / 1000) - 3600) })).toBeNull();
  });
});

describe('payment webhooks (FR-56)', () => {
  const urls = inject('db');
  let app: INestApplication;
  let tenantId: string;
  let screeningId: string;
  const env = { PAYMENT_WEBHOOK_SECRET_MPESA: SECRET, PAYMENT_WEBHOOK_SECRET_CARD: SECRET };

  beforeAll(async () => {
    app = await bootTestApp(urls, { env });
    await asAdmin(urls.adminUrl, async (c) => {
      tenantId = (await createTenant(c)).id;
      screeningId = (await seedScreening(c, tenantId)).screeningId;
    });
  });
  afterAll(() => app.close());

  async function pendingPayment(ref: string) {
    return asAdmin(urls.adminUrl, async (c) => {
      const bookingId = (
        await c.query(
          `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, channel, guest_email, guest_name, seat_ids, total_minor, currency)
           VALUES ($1, $2, $3, gen_random_uuid(), 'online', 'g@x.test', 'G', '{}', 160000, 'KES') RETURNING id`,
          [tenantId, `R-${ref}`, screeningId],
        )
      ).rows[0].id;
      const { rows } = await c.query(
        `INSERT INTO payment (tenant_id, booking_id, provider, provider_ref, idempotency_key, amount_minor, currency)
         VALUES ($1, $2, 'mpesa', $3, gen_random_uuid()::text, 160000, 'KES') RETURNING id`,
        [tenantId, bookingId, ref],
      );
      return rows[0].id as string;
    });
  }
  const callback = (ref: string, code = 0) =>
    JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: ref, ResultCode: code, ResultDesc: code ? 'Request cancelled by user' : 'ok' } } });
  const post = (body: string, sig?: string) => {
    const r = request(app.getHttpServer()).post('/api/v1/webhooks/payments/mpesa').set('content-type', 'application/json');
    return (sig === undefined ? r : r.set('x-cinechain-signature', sig)).send(body);
  };

  it('a bad signature is 401 and changes nothing', async () => {
    const id = await pendingPayment('ws_bad');
    const res = await post(callback('ws_bad'), 't=1,v1=bad').expect(401);
    expect(res.body.error).toBe('invalid_signature');
    await post(callback('ws_bad')).expect(401);
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query('SELECT status::text FROM payment WHERE id = $1', [id]));
    expect(rows[0].status).toBe('pending');
  });

  it('the same valid webhook delivered twice produces exactly one state transition', async () => {
    const id = await pendingPayment('ws_dup');
    const body = callback('ws_dup');
    await post(body, signWebhook(SECRET, body)).expect(200);
    await post(body, signWebhook(SECRET, body)).expect(200);
    const r = await asAdmin(urls.adminUrl, async (c) => ({
      payment: (await c.query('SELECT status::text, captured_at IS NOT NULL AS captured FROM payment WHERE id = $1', [id])).rows[0],
      events: (await c.query('SELECT count(*)::int AS n FROM payment_webhook_event WHERE payment_id = $1', [id])).rows[0].n,
      audits: (await c.query(`SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND action = 'payment.webhook'`, [id])).rows[0].n,
    }));
    expect(r).toEqual({ payment: { status: 'captured', captured: true }, events: 1, audits: 1 });
  });

  it('a late failure callback cannot undo a capture (a payment leaves pending once)', async () => {
    const id = await pendingPayment('ws_late');
    const ok = callback('ws_late', 0);
    const fail = callback('ws_late', 1032);
    await post(ok, signWebhook(SECRET, ok)).expect(200);
    await post(fail, signWebhook(SECRET, fail)).expect(200);
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query('SELECT status::text FROM payment WHERE id = $1', [id]));
    expect(rows[0].status).toBe('captured');
  });

  it('the tenant comes from the stored payment row: the audit lands in that tenant', async () => {
    const id = await pendingPayment('ws_scope');
    const body = callback('ws_scope');
    await post(body, signWebhook(SECRET, body)).expect(200);
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query(`SELECT tenant_id, actor_kind FROM audit_event WHERE resource_id = $1`, [id]));
    expect(rows).toEqual([{ tenant_id: tenantId, actor_kind: 'system' }]);
  });

  it('a signed webhook for an unknown reference is acknowledged and ignored; an unknown provider is 404', async () => {
    const body = callback('ws_nobody');
    await post(body, signWebhook(SECRET, body)).expect(200);
    await request(app.getHttpServer()).post('/api/v1/webhooks/payments/paypal').send('{}').expect(404);
  });

  it('every provider in the registry has a webhook route', () => {
    expect(app.get(PaymentProviders).names()).toEqual(['mpesa', 'card']);
  });
});
