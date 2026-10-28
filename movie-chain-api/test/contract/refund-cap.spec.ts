/**
 * FR-64, property-tested against the database itself: whatever sequence of
 * refunds is attempted — sequential or concurrent — the refunds that are not
 * `failed` never add up to more than the capture. No application code runs:
 * this is the trigger, as cinechain_app, under RLS.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asAdmin, createTenant } from '../support/seed';
import { seedScreening } from '../support/seed-screening';

const urls = inject('db');
let tenantId: string;
let screeningId: string;

/** A deterministic PRNG, so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

let shared: Client;

/** One transaction as cinechain_app, under RLS. `client` defaults to one shared connection. */
async function asApp<T>(fn: (c: Client) => Promise<T>, client: Client = shared): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

async function capturedPayment(amount: number): Promise<string> {
  return asAdmin(urls.adminUrl, async (c) => {
    const b = (
      await c.query(
        `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, channel, guest_email, guest_name, seat_ids, total_minor, currency)
         VALUES ($1, 'CAP-' || substr(md5(random()::text), 1, 8), $2, gen_random_uuid(), 'online', 'c@x.test', 'C', '{}', $3, 'KES') RETURNING id`,
        [tenantId, screeningId, amount],
      )
    ).rows[0].id;
    return (
      await c.query(
        `INSERT INTO payment (tenant_id, booking_id, provider, idempotency_key, status, amount_minor, currency, captured_at)
         VALUES ($1, $2, 'mpesa', $4, 'captured', $3, 'KES', now()) RETURNING id`,
        [tenantId, b, amount, String(b)],
      )
    ).rows[0].id;
  });
}

const tryRefund = (paymentId: string, amount: number, status = 'pending', client?: Client) =>
  asApp((c) =>
    c.query(
      `INSERT INTO payment_refund (tenant_id, payment_id, amount_minor, currency, reason, idempotency_key, status)
       VALUES ($1, $2, $3, 'KES', 'prop', gen_random_uuid()::text, $4)`,
      [tenantId, paymentId, amount, status],
    ),
    client,
  ).then(
    () => true,
    (e: { code?: string; constraint?: string }) => {
      if (e.code !== '23514' || e.constraint !== 'refund_within_capture') throw e;
      return false;
    },
  );

const live = async (paymentId: string) =>
  Number((await asApp((c) => c.query(`SELECT coalesce(sum(amount_minor), 0) AS s FROM payment_refund WHERE payment_id = $1 AND status <> 'failed'`, [paymentId]))).rows[0].s);

beforeAll(async () => {
  shared = new Client({ connectionString: urls.appUrl });
  await shared.connect();
  await asAdmin(urls.adminUrl, async (c) => {
    tenantId = (await createTenant(c)).id;
    screeningId = (await seedScreening(c, tenantId)).screeningId;
  });
});
afterAll(() => shared.end());

describe('refund cap (FR-64)', () => {
  it('50 random refund sequences: the live total never exceeds the capture, and every refusal was necessary', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed);
      const captured = 1000 + Math.floor(r() * 9000);
      const paymentId = await capturedPayment(captured);
      for (let i = 0; i < 8; i++) {
        const amount = 1 + Math.floor(r() * captured * 0.6);
        const failed = r() < 0.2; // a failed refund does not count against the cap
        const before = await live(paymentId);
        const ok = await tryRefund(paymentId, amount, failed ? 'failed' : 'pending');
        const after = await live(paymentId);
        expect(after, `seed ${seed}`).toBeLessThanOrEqual(captured);
        if (!failed) expect(ok, `seed ${seed} step ${i}: refused only when it would exceed`).toBe(before + amount <= captured);
      }
    }
  });

  it('ten concurrent refunds of 30 % each: at most three succeed', async () => {
    const paymentId = await capturedPayment(10000);
    const clients = Array.from({ length: 10 }, () => new Client({ connectionString: urls.appUrl }));
    await Promise.all(clients.map((c) => c.connect()));
    const results = await Promise.all(clients.map((c) => tryRefund(paymentId, 3000, 'pending', c)));
    await Promise.all(clients.map((c) => c.end()));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await live(paymentId)).toBe(9000);
  });

  it('nothing can be refunded on a payment that was never captured', async () => {
    const paymentId = await capturedPayment(5000);
    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE payment SET status = 'pending', captured_at = NULL WHERE id = $1`, [paymentId]));
    expect(await tryRefund(paymentId, 1)).toBe(false);
  });
});
