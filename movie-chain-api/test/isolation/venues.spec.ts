import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { StaffInviteMailer } from '../../src/staff/staff-invite.mailer';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';
import { seedVenueTenant, type VenueTenant } from './helpers/seed-venue-tenant';

const urls = inject('db');
let app: INestApplication;
let A: VenueTenant;
let B: VenueTenant;
let admin: string;
const http = () => request(app.getHttpServer());
const login = (email: string, slug: string, password = TEST_PASSWORD) =>
  http().post('/api/v1/auth/staff/login').send({ email, password, tenant_slug: slug });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  A = await seedVenueTenant(urls.adminUrl, 'venue-a');
  B = await seedVenueTenant(urls.adminUrl, 'venue-b');
  app = await bootTestApp(urls);
  admin = (await login(A.adminEmail, A.slug)).body.access_token;
});
afterAll(() => app.close());

describe('venues', () => {
  it('generates a 12 × 20 layout (240 seats), and refuses a second generate', async () => {
    const t = await http().post('/api/v1/theatres').set(bearer(admin)).send({ name: 'Sarit', city: 'Nairobi' }).expect(201);
    const s = await http().post('/api/v1/screens').set(bearer(admin)).send({ theatre_id: t.body.id, name: 'Screen 4', format: 'imax' }).expect(201);
    const gen = await http()
      .post(`/api/v1/screens/${s.body.id}/seats:generate`)
      .set(bearer(admin))
      .send({ rows: 12, seatsPerRow: 20, defaultClass: 'standard', aisleAfter: [5, 15], rowClasses: [{ rows: ['L'], seatClass: 'vip' }] });
    expect([gen.status, gen.body.created]).toEqual([201, 240]);
    const again = await http().post(`/api/v1/screens/${s.body.id}/seats:generate`).set(bearer(admin)).send({ rows: 1, seatsPerRow: 1 });
    expect([again.status, again.body.error]).toEqual([409, 'layout_exists']);
    const screen = await http().get(`/api/v1/screens/${s.body.id}`).set(bearer(admin)).expect(200);
    expect(screen.body.capacity).toBe(240);
    expect(screen.body.seats.filter((x: { seat_class: string }) => x.seat_class === 'vip')).toHaveLength(20);
    expect(screen.body.seats.find((x: { row: string; number: number }) => x.row === 'A' && x.number === 6).x).toBe(6); // after the aisle
  });

  it("refuses a screen in another chain's theatre with 404", async () => {
    const res = await http().post('/api/v1/screens').set(bearer(admin)).send({ theatre_id: B.theatreId, name: 'Probe' });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown time zone', async () => {
    const res = await http().post('/api/v1/theatres').set(bearer(admin)).send({ name: 'Bad TZ', city: 'X', timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });

  it('takes a screen out of service and restores it (FR-15)', async () => {
    const off = await http().post(`/api/v1/screens/${A.screenId}/out-of-service`).set(bearer(admin)).send({ reason: 'projector repair' }).expect(200);
    expect(off.body).toMatchObject({ status: 'out_of_service', out_of_service_reason: 'projector repair' });
    const on = await http().post(`/api/v1/screens/${A.screenId}/restore`).set(bearer(admin)).expect(200);
    expect(on.body).toMatchObject({ status: 'active', out_of_service_reason: null });
  });

  it('a box-office clerk cannot change seats (403 insufficient_role — a role check, not an existence oracle)', async () => {
    const clerk = (await login(`clerk@venue-a.test`, A.slug)).body.access_token;
    const res = await http().patch(`/api/v1/seats/${A.seatId}`).set(bearer(clerk)).send({ is_active: false });
    expect([res.status, res.body.error]).toEqual([403, 'insufficient_role']);
  });
});

describe('theatre scoping (FR-5)', () => {
  let manager: string;

  beforeAll(async () => {
    await asAdmin(urls.adminUrl, async (c) => {
      const id = await addStaff(c, A.id, 'manager@venue-a.test', 'theatre_manager');
      await c.query(`INSERT INTO staff_theatre (tenant_id, staff_user_id, theatre_id) VALUES ($1, $2, $3)`, [A.id, id, A.theatreId]);
    });
    manager = (await login('manager@venue-a.test', A.slug)).body.access_token;
  });

  it('a manager scoped to theatre X sees X and gets 404 for theatre Z in the SAME chain', async () => {
    await http().get(`/api/v1/theatres/${A.theatreId}`).set(bearer(manager)).expect(200);
    const z = await http().get(`/api/v1/theatres/${A.otherTheatreId}`).set(bearer(manager));
    const missing = await http().get('/api/v1/theatres/00000000-0000-4000-8000-000000000000').set(bearer(manager));
    expect(z.status).toBe(404);
    expect(z.text).toBe(missing.text);
    await http().get(`/api/v1/screens/${A.otherScreenId}`).set(bearer(manager)).expect(404);
    await http().post('/api/v1/screens').set(bearer(manager)).send({ theatre_id: A.otherTheatreId, name: 'Sneaky' }).expect(404);
  });

  it('lists only the theatres in scope', async () => {
    const list = await http().get('/api/v1/theatres').set(bearer(manager)).expect(200);
    expect(list.body.map((t: { id: string }) => t.id)).toEqual([A.theatreId]);
  });
});

describe('staff management (FR-5)', () => {
  it('invites with a theatre scope; the link activates once; the new user is scoped', async () => {
    const inv = await http()
      .post('/api/v1/staff/invitations')
      .set(bearer(admin))
      .send({ email: 'new-manager@venue-a.test', role: 'theatre_manager', theatre_ids: [A.otherTheatreId] })
      .expect(201);
    expect(inv.body).toMatchObject({ status: 'invited', theatre_ids: [A.otherTheatreId] });
    const token = app.get(StaffInviteMailer).outbox.get('new-manager@venue-a.test')!;
    await http().post('/api/v1/auth/staff/activate').send({ tenant_slug: A.slug, token, password: 'new-manager-password' }).expect(204);
    await http().post('/api/v1/auth/staff/activate').send({ tenant_slug: A.slug, token, password: 'again-password-1' }).expect(400);
    const t = (await login('new-manager@venue-a.test', A.slug, 'new-manager-password')).body.access_token;
    await http().get(`/api/v1/theatres/${A.otherTheatreId}`).set(bearer(t)).expect(200);
    await http().get(`/api/v1/theatres/${A.theatreId}`).set(bearer(t)).expect(404);
  });

  it("refuses to scope a user to another chain's theatre (404)", async () => {
    const res = await http()
      .post('/api/v1/staff/invitations')
      .set(bearer(admin))
      .send({ email: 'x@venue-a.test', role: 'box_office', theatre_ids: [B.theatreId] });
    expect(res.status).toBe(404);
    const n = await asAdmin(urls.adminUrl, (c) => c.query(`SELECT count(*)::int AS n FROM staff_user WHERE email = 'x@venue-a.test'`));
    expect(n.rows[0].n).toBe(0); // the whole invite rolled back
  });

  it("a suspended user's refresh token is rejected on its next use", async () => {
    const clerkSession = (await login(`clerk@venue-a.test`, A.slug)).body;
    await http().post(`/api/v1/staff/${A.clerkId}/suspend`).set(bearer(admin)).expect(200);
    const res = await http().post('/api/v1/auth/staff/refresh').send({ refresh_token: clerkSession.refresh_token });
    expect([res.status, res.body.error]).toEqual([401, 'session_revoked']);
    await login(`clerk@venue-a.test`, A.slug).expect(401);
    await http().post(`/api/v1/staff/${A.clerkId}/reactivate`).set(bearer(admin)).expect(200);
    await login(`clerk@venue-a.test`, A.slug).expect(200);
  });

  it('the last active chain_admin cannot be suspended or removed', async () => {
    const solo = await seedVenueTenant(urls.adminUrl, 'solo');
    const t = (await login(solo.adminEmail, solo.slug)).body.access_token;
    const s = await http().post(`/api/v1/staff/${solo.adminId}/suspend`).set(bearer(t));
    expect([s.status, s.body.error]).toEqual([409, 'last_chain_admin']);
    await http().delete(`/api/v1/staff/${solo.adminId}`).set(bearer(t)).expect(409);
  });

  it('two admins suspending each other at the same moment leave exactly one active', async () => {
    const pair = await seedVenueTenant(urls.adminUrl, 'pair');
    const secondId = await asAdmin(urls.adminUrl, (c) => addStaff(c, pair.id, 'second@pair.test', 'chain_admin'));
    const t1 = (await login(pair.adminEmail, pair.slug)).body.access_token;
    const t2 = (await login('second@pair.test', pair.slug)).body.access_token;
    const results = await Promise.all([
      http().post(`/api/v1/staff/${secondId}/suspend`).set(bearer(t1)),
      http().post(`/api/v1/staff/${pair.adminId}/suspend`).set(bearer(t2)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const n = await asAdmin(urls.adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM staff_user WHERE tenant_id = $1 AND role = 'chain_admin' AND status = 'active'`, [pair.id]),
    );
    expect(n.rows[0].n).toBe(1);
  });
});
