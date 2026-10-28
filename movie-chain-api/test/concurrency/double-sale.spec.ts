/**
 * With Redis out of the picture entirely, Postgres alone must still refuse a
 * second holder and a second sale of the same seat.
 */
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fetchHold, listen, seedSellable } from '../support/holds';
import { asAdmin } from '../support/seed';
import { bootTestApp } from '../support/test-app';
import { race } from './harness';

const urls = inject('db');
let noRedis: INestApplication;
let base: string;

beforeAll(async () => {
  noRedis = await bootTestApp(urls, { env: { REDIS_URL: 'redis://127.0.0.1:1', DATABASE_POOL_MAX: '40' } });
  base = await listen(noRedis);
});
afterAll(() => noRedis.close());

/** The step-18 conversion: check-and-act collapsed into ONE statement. */
const CONVERT = `UPDATE seat_lock SET status = 'sold', expires_at = NULL, booking_id = $1
                  WHERE screening_id = $2 AND seat_id = ANY($3::uuid[])
                    AND hold_id = $4 AND status = 'held' AND expires_at > now()
                 RETURNING seat_id`;

describe('double sale, Redis bypassed', () => {
  it('50 simultaneous holds on one seat with no Redis at all: exactly one 201', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const results = await race(50, () => () => fetchHold(base, t.screeningId, [t.seatIds[0]!]));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(49);
  });

  it('two conversions of the same hold forced at once: Postgres converts it exactly once', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const hold = await fetchHold(base, t.screeningId, [t.seatIds[0]!]);
    expect(hold.status).toBe(201);
    const clients = [new Client({ connectionString: urls.appUrl }), new Client({ connectionString: urls.appUrl })];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      for (const c of clients) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.tenantId]);
      }
      // Two real bookings (seat_lock.booking_id is a composite FK); the second for the same hold must be
      // a non-live one, since a hold has at most one live booking.
      const [b1, b2] = await asAdmin(urls.adminUrl, async (a) => {
        const ins = (status: string) =>
          a.query(
            `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, status, channel, guest_email, guest_name, seat_ids, total_minor, currency)
             VALUES ($1, 'DS-' || substr(md5(random()::text), 1, 6), $2, $3, $4::booking_status, 'online', 'd@x.test', 'D', ARRAY[$5::uuid], 80000, 'KES') RETURNING id`,
            [t.tenantId, t.screeningId, hold.body.hold_id, status, t.seatIds[0]],
          );
        return [(await ins('pending')).rows[0].id as string, (await ins('expired')).rows[0].id as string];
      });
      const first = await clients[0]!.query(CONVERT, [b1, t.screeningId, [t.seatIds[0]], hold.body.hold_id]);
      const second = clients[1]!.query(CONVERT, [b2, t.screeningId, [t.seatIds[0]], hold.body.hold_id]); // blocks on the row
      await clients[0]!.query('COMMIT');
      const r2 = await second;
      await clients[1]!.query('COMMIT');
      expect([first.rowCount, r2.rowCount]).toEqual([1, 0]);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query('SELECT status::text, booking_id IS NOT NULL AS booked FROM seat_lock WHERE seat_id = $1', [t.seatIds[0]]));
    expect(rows).toEqual([{ status: 'sold', booked: true }]);
  });

  it('a sold seat cannot be held again, and the primary key refuses a raw second row', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    await asAdmin(urls.adminUrl, (c) =>
      c.query(`INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status) VALUES ($1, $2, $3, 'sold')`, [t.screeningId, t.seatIds[0], t.tenantId]),
    );
    expect((await fetchHold(base, t.screeningId, [t.seatIds[0]!])).status).toBe(409);
    await expect(
      asAdmin(urls.adminUrl, (c) =>
        c.query(`INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status) VALUES ($1, $2, $3, 'sold')`, [t.screeningId, t.seatIds[0], t.tenantId]),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
