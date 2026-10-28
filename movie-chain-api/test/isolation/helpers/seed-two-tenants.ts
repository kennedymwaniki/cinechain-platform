import type { TenantTable } from '../../../src/db/tenant-tables';
import { addCustomers, asAdmin, createTenant, type SeededTenant } from '../../support/seed';

export interface TwoTenants {
  A: SeededTenant;
  B: SeededTenant;
  /**
   * Rows per tenant in EVERY tenant table, so per-scope counts are asserted
   * exactly. Typed as Record<TenantTable, …>: adding a table to TENANT_TABLES
   * without seeding it here is a compile error.
   */
  expected: { A: Record<TenantTable, number>; B: Record<TenantTable, number> };
}

/** Tenants A and B with PARALLEL data — same shapes, different counts. */
export async function seedTwoTenants(adminUrl: string): Promise<TwoTenants> {
  return asAdmin(adminUrl, async (c) => {
    const A = await createTenant(c);
    const B = await createTenant(c);
    await addCustomers(c, A.id, 3);
    await addCustomers(c, B.id, 2);
    for (const [t, n] of [
      [A, 2],
      [B, 1],
    ] as const)
      for (let i = 0; i < n; i++)
        // The same e-mail in both chains: unique per tenant, not globally.
        await c.query(`INSERT INTO staff_user (tenant_id, email, role) VALUES ($1, $2, 'box_office')`, [
          t.id,
          `clerk${i}@shared.test`,
        ]);
    for (const t of [A, B])
      await c.query(
        `INSERT INTO staff_activation (tenant_id, token_hash, staff_user_id, expires_at)
         SELECT tenant_id, md5(random()::text), id, now() + interval '1 day' FROM staff_user WHERE tenant_id = $1 LIMIT 1`,
        [t.id],
      );
    for (const [t, theatres] of [
      [A, 1],
      [B, 2],
    ] as const)
      for (let i = 0; i < theatres; i++) {
        const th = await c.query<{ id: string }>(`INSERT INTO theatre (tenant_id, name, city) VALUES ($1, $2, 'Nairobi') RETURNING id`, [t.id, `T${i}`]);
        const sc = await c.query<{ id: string }>(`INSERT INTO screen (tenant_id, theatre_id, name) VALUES ($1, $2, 'S1') RETURNING id`, [t.id, th.rows[0]!.id]);
        await c.query(
          `INSERT INTO seat (tenant_id, screen_id, row_label, seat_number, row_index, col_index)
           SELECT $1, $2, 'A', n, 0, n - 1 FROM generate_series(1, 6) n`,
          [t.id, sc.rows[0]!.id],
        );
        const fm = await c.query<{ id: string }>(`INSERT INTO film (tenant_id, title, runtime_min) VALUES ($1, 'Avengers: Doomsday', 150) RETURNING id`, [t.id]);
        const scr = await c.query<{ id: string }>(
          `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format)
           VALUES ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 150 minutes', 60, 'standard') RETURNING id`,
          [t.id, sc.rows[0]!.id, fm.rows[0]!.id],
        );
        await c.query(
          `INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status)
           SELECT $1, id, tenant_id, 'sold' FROM seat WHERE screen_id = $2 ORDER BY seat_number LIMIT 2`,
          [scr.rows[0]!.id, sc.rows[0]!.id],
        );
        await c.query(
          `INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from) VALUES ($1, $2, 65000, 'KES', now())`,
          [t.id, i === 0 ? 'standard' : 'vip'],
        );
        if (i === 0)
          await c.query(`INSERT INTO staff_theatre (tenant_id, staff_user_id, theatre_id) SELECT tenant_id, id, $2 FROM staff_user WHERE tenant_id = $1 LIMIT 1`, [
            t.id,
            th.rows[0]!.id,
          ]);
      }
    for (const [t, n] of [
      [A, 1],
      [B, 3],
    ] as const)
      for (let i = 0; i < n; i++) {
        await c.query(
          `INSERT INTO audit_event (tenant_id, actor_kind, action, resource_type) VALUES ($1, 'system', 'seed', 'test')`,
          [t.id],
        );
        await c.query(
          `INSERT INTO idempotency_key (tenant_id, key, endpoint, request_hash) VALUES ($1, $2, 'POST /x', 'h')`,
          [t.id, `k${i}`],
        );
      }
    for (const [t, n] of [
      [A, 1],
      [B, 2],
    ] as const)
      for (let i = 0; i < n; i++) {
        const scr = (await c.query(`SELECT id, screen_id FROM screening WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [t.id])).rows[0];
        const seatId = (await c.query(`SELECT id FROM seat WHERE screen_id = $1 ORDER BY seat_number DESC OFFSET $2 LIMIT 1`, [scr.screen_id, i])).rows[0].id;
        const bk = await c.query<{ id: string }>(
          `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, status, channel, guest_email, guest_name, seat_ids, total_minor, currency)
           VALUES ($1, $2, $3, gen_random_uuid(), 'confirmed', 'online', 'guest@shared.test', 'Guest', ARRAY[$4::uuid], 130000, 'KES') RETURNING id`,
          [t.id, `REF-${i}`, scr.id, seatId],
        );
        await c.query(
          `INSERT INTO ticket (tenant_id, booking_id, screening_id, seat_id, code_hash, price_minor, currency)
           VALUES ($1, $2, $3, $4, gen_random_uuid()::text::bytea, 130000, 'KES')`,
          [t.id, bk.rows[0]!.id, scr.id, seatId],
        );
        await c.query(`INSERT INTO loyalty_ledger (tenant_id, booking_id, kind, email, points) VALUES ($1, $2, 'award', 'guest@shared.test', 13)`, [t.id, bk.rows[0]!.id]);
        await c.query(`INSERT INTO outbox_event (tenant_id, kind, payload) VALUES ($1, 'booking.confirmed', '{}')`, [t.id]);
        await c.query(
          `INSERT INTO admission_event (tenant_id, ticket_id, screening_id, result, device_id, operator_id)
           SELECT tenant_id, id, screening_id, 'valid', 'gate', gen_random_uuid() FROM ticket WHERE booking_id = $1`,
          [bk.rows[0]!.id],
        );
        const pay = await c.query<{ id: string }>(
          `INSERT INTO payment (tenant_id, booking_id, provider, provider_ref, idempotency_key, status, amount_minor, currency, captured_at)
           VALUES ($1, $2, 'mpesa', $3, gen_random_uuid()::text, 'captured', 130000, 'KES', now()) RETURNING id`,
          [t.id, bk.rows[0]!.id, `ws_${t.id}_${i}`],
        );
        await c.query(
          `INSERT INTO payment_refund (tenant_id, payment_id, amount_minor, currency, reason, idempotency_key, status)
           VALUES ($1, $2, 65000, 'KES', 'seed', gen_random_uuid()::text, 'succeeded')`,
          [t.id, pay.rows[0]!.id],
        );
        await c.query(
          `INSERT INTO payment_webhook_event (tenant_id, provider, event_id, payment_id, status) VALUES ($1, 'mpesa', $2, $3, 'captured')`,
          [t.id, `ev_${i}`, pay.rows[0]!.id],
        );
      }
    return {
      A,
      B,
      expected: {
        A: { tenant_customer: 3, staff_user: 2, audit_event: 1, idempotency_key: 1, staff_activation: 1, theatre: 1, screen: 1, seat: 6, staff_theatre: 1, film: 1, pricing_rule: 1, screening: 1, seat_lock: 2, payment: 1, payment_refund: 1, payment_webhook_event: 1, booking: 1, ticket: 1, loyalty_ledger: 1, outbox_event: 1, admission_event: 1 },
        B: { tenant_customer: 2, staff_user: 1, audit_event: 3, idempotency_key: 3, staff_activation: 1, theatre: 2, screen: 2, seat: 12, staff_theatre: 1, film: 2, pricing_rule: 2, screening: 2, seat_lock: 4, payment: 2, payment_refund: 2, payment_webhook_event: 2, booking: 2, ticket: 2, loyalty_ledger: 2, outbox_event: 2, admission_event: 2 },
      },
    };
  });
}
