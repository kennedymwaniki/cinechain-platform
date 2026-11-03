/**
 * Step 22. Aggregates are the easiest place for isolation to leak — a SUM
 * over an unscoped table looks perfectly innocent — and reporting must never
 * be able to starve booking of connections.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ReportingRepository } from '../../src/reporting/reporting.repository';
import { ReportingDb } from '../../src/tenancy/reporting-db.provider';
import { runWithTenant } from '../../src/tenancy/tenant-context';
import { TenantDb } from '../../src/tenancy/tenant-db.provider';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD } from '../support/seed';
import { seedScreening } from '../support/seed-screening';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
const http = () => request(app.getHttpServer());
const from = new Date(Date.now() - 3600_000).toISOString();
const to = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

interface Chain {
  id: string;
  slug: string;
  screeningId: string;
  theatreId: string;
  seatIds: string[];
  admin: string;
  manager: string;
}

/** A chain with one screening and `sales` confirmed single-seat bookings at `price` each. */
async function chain(label: string, sales: number, price: number): Promise<Chain> {
  return asAdmin(urls.adminUrl, async (c) => {
    const t = await createTenant(c);
    await addStaff(c, t.id, `admin@${label}.test`, 'chain_admin');
    await addStaff(c, t.id, `mgr@${label}.test`, 'theatre_manager');
    const s = await seedScreening(c, t.id, { seats: 6, city: 'Reportville' }); // its own town: discovery specs assert on Nairobi exactly
    await c.query(
      `INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from) VALUES ($1, 'standard', $2, 'KES', now() - interval '1 day')`,
      [t.id, price],
    );
    for (let i = 0; i < sales; i++) {
      const b = (
        await c.query(
          `INSERT INTO booking (tenant_id, reference, screening_id, hold_id, status, channel, guest_email, guest_name, seat_ids, total_minor, currency, confirmed_at)
           VALUES ($1, $2, $3, gen_random_uuid(), 'confirmed', 'online', 'r@x.test', 'R', ARRAY[$4::uuid], $5, 'KES', now()) RETURNING id`,
          [t.id, `RPT-${i}`, s.screeningId, s.seatIds[i], price],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO ticket (tenant_id, booking_id, screening_id, seat_id, code_hash, price_minor, currency) VALUES ($1, $2, $3, $4, gen_random_uuid()::text::bytea, $5, 'KES')`,
        [t.id, b, s.screeningId, s.seatIds[i], price],
      );
      await c.query(`INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status, booking_id) VALUES ($1, $2, $3, 'sold', $4)`, [s.screeningId, s.seatIds[i], t.id, b]);
    }
    return { id: t.id, slug: t.slug, screeningId: s.screeningId, theatreId: s.theatreId, seatIds: s.seatIds, admin: `admin@${label}.test`, manager: `mgr@${label}.test` };
  });
}

const login = async (c: Chain, email: string) =>
  (await http().post('/api/v1/auth/staff/login').send({ email, password: TEST_PASSWORD, tenant_slug: c.slug }).expect(200)).body.access_token as string;

let A: Chain;
let B: Chain;
let adminA: string;

beforeAll(async () => {
  A = await chain('rpt-a', 3, 80000);
  B = await chain('rpt-b', 5, 120000);
  app = await bootTestApp(urls, { env: { DATABASE_REPORTING_POOL_MAX: '2' } });
  adminA = await login(A, A.admin);
});
afterAll(() => app.close());

describe('reports are tenant-scoped (A-1)', () => {
  it("revenue equals tenant A's confirmed bookings and strictly excludes tenant B's", async () => {
    const res = await http().get('/api/v1/reports/revenue').query({ from, to }).set('authorization', `Bearer ${adminA}`).expect(200);
    expect(res.body).toMatchObject({ total_minor: 240000, bookings: 3, tickets: 3, currency: 'KES', stale_after_s: 60 });
    // the same SUM with no tenant scope would include B: prove the scope is what excluded it
    const all = (await asAdmin(urls.adminUrl, (c) => c.query(`SELECT sum(price_minor)::int AS s FROM ticket WHERE tenant_id = ANY($1::uuid[])`, [[A.id, B.id]]))).rows[0].s;
    expect(all).toBe(240000 + 600000);
    expect(res.text).not.toContain(B.id);
    expect(res.text).not.toContain(B.theatreId);
  });

  it("occupancy lists only the caller's screenings, live", async () => {
    const res = await http().get('/api/v1/reports/occupancy').query({ from, to }).set('authorization', `Bearer ${adminA}`).expect(200);
    expect(res.body.screenings.map((s: { screening_id: string }) => s.screening_id)).toEqual([A.screeningId]);
    expect(res.body.screenings[0]).toMatchObject({ capacity: 6, sold: 3, held: 0, available: 3, occupancy_bp: 5000 });
    await http().get('/api/v1/reports/occupancy').query({ from, to, theatre_id: B.theatreId }).set('authorization', `Bearer ${adminA}`).expect(404);
  });

  it('revenue is chain-admin only; occupancy is open to managers', async () => {
    const mgr = await login(A, A.manager);
    await http().get('/api/v1/reports/revenue').query({ from, to }).set('authorization', `Bearer ${mgr}`).expect(403);
    await http().get('/api/v1/reports/occupancy').query({ from, to }).set('authorization', `Bearer ${mgr}`).expect(200);
  });

  it('every aggregate runs inside a tenant scope: called bare, the repository refuses', async () => {
    await expect(app.get(ReportingRepository).revenueByTheatre(new Date(from), new Date(to))).rejects.toThrow(/No tenant DB scope/);
  });
});

describe('the reporting pool cannot starve booking', () => {
  it('with every reporting connection busy, bookings and staff routes still succeed, and reports fail fast with 503', async () => {
    const reporting = app.get(ReportingDb);
    const repo = app.get(ReportingRepository);
    const ctx = { tenantId: A.id, actor: { kind: 'system' as const, reason: 'exhaust' } };
    // DATABASE_REPORTING_POOL_MAX=2: occupy both.
    const busy = [0, 1].map(() => runWithTenant(ctx, () => reporting.withTenantScope(() => repo.sleep(4))));
    await new Promise((r) => setTimeout(r, 300));

    const t0 = Date.now();
    const hold = await http().post(`/api/v1/screenings/${A.screeningId}/holds`).send({ seat_ids: [A.seatIds[5]] });
    expect(hold.status).toBe(201); // a guest hold, on the booking pool (Redis absent here: the Postgres path)
    await http().get('/api/v1/theatres').set('authorization', `Bearer ${adminA}`).expect(200);
    expect(Date.now() - t0).toBeLessThan(1500);

    const report = await http().get('/api/v1/reports/occupancy').query({ from, to }).set('authorization', `Bearer ${adminA}`);
    expect(report.status).toBe(503);
    expect(report.body.error).toBe('reporting_busy');
    await Promise.all(busy);
  });

  it('a reporting scope can never nest inside a booking-pool transaction (it would silently use booking’s connection)', async () => {
    const ctx = { tenantId: A.id, actor: { kind: 'system' as const, reason: 'nest' } };
    await expect(
      runWithTenant(ctx, () => app.get(TenantDb).withTenantScope(() => app.get(ReportingDb).withTenantScope(async () => 1))),
    ).rejects.toThrow(/different pool/);
  });
});
