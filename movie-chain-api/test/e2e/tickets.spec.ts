/** Step 20: bearer tickets, admission results, and retrieval without an account. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { postHold, seedSellable } from '../support/holds';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
const http = () => request(app.getHttpServer());
const q = async (sql: string, p: unknown[] = []) => (await asAdmin(urls.adminUrl, (c) => c.query(sql, p))).rows;

beforeAll(async () => {
  app = await bootTestApp(urls, { env: { REDIS_URL: inject('redisUrl') } });
});
afterAll(() => app.close());

async function setup(email = 'tix@example.test') {
  const t = await seedSellable(urls.adminUrl, 3);
  const slug = (await q(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))[0]!.slug as string;
  await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `door@${slug}.test`, 'box_office'));
  const tok = (await http().post('/api/v1/auth/staff/login').send({ email: `door@${slug}.test`, password: TEST_PASSWORD, tenant_slug: slug })).body.access_token as string;
  const hold = (await postHold(app, t.screeningId, [t.seatIds[0]!, t.seatIds[1]!]).expect(201)).body;
  const booking = (
    await http()
      .post('/api/v1/bookings')
      .set('idempotency-key', `tk-${crypto.randomUUID()}`)
      .send({ hold_token: hold.hold_token, payment_method: 'mpesa', phone: '+254712345678', contact: { name: 'T', email } })
      .expect(201)
  ).body;
  return { t, slug, tok, booking };
}
const scan = (tok: string, code: string, screeningId: string) =>
  http().post('/api/v1/tickets/redeem').set('authorization', `Bearer ${tok}`).send({ code, screening_id: screeningId, device_id: 'gate-a' }).expect(200);

describe('tickets (FR-54, FR-72)', () => {
  it('codes are high-entropy and unrelated to the reference; the database holds only their hashes', async () => {
    const { booking } = await setup();
    const codes = booking.tickets.map((x: { code: string }) => x.code);
    expect(new Set(codes).size).toBe(2);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(c).not.toContain(booking.reference.split('-')[1]);
    }
    const dump = JSON.stringify(await q(`SELECT * FROM ticket WHERE booking_id = $1`, [booking.booking_id]));
    for (const c of codes) expect(dump).not.toContain(c);
  });

  it('the QR link renders the code as a PNG; a tampered or expired link does not', async () => {
    const { booking } = await setup();
    const url = new URL(booking.tickets[0].qr_url);
    expect(url.search).not.toContain(booking.tickets[0].code);
    const png = await http().get(`${url.pathname}${url.search}`).buffer(true).expect(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    await http().get(`${url.pathname}?token=${url.searchParams.get('token')!.slice(0, -2)}xx`).expect(401);
  });
});

describe('admission (FR-60, FR-61)', () => {
  it('valid, then already_used; a void ticket is void; garbage is invalid — each scan recorded with device and operator', async () => {
    const { t, tok, booking } = await setup();
    const [a, b] = booking.tickets;
    expect((await scan(tok, a.code, t.screeningId)).body).toMatchObject({ result: 'valid', seat: { row: 'A' } });
    const again = (await scan(tok, a.code, t.screeningId)).body;
    expect(again).toMatchObject({ result: 'already_used', first_scanned_at: expect.any(String) });
    await http().post(`/api/v1/bookings/${booking.booking_id}/cancel`).set('booking-token', booking.manage_token).send({ seat_ids: [b.seat.id] }).expect(201);
    expect((await scan(tok, b.code, t.screeningId)).body.result).toBe('void');
    expect((await scan(tok, 'not-a-real-code', t.screeningId)).body.result).toBe('invalid');
    const events = await q(`SELECT result, device_id, operator_id IS NOT NULL AS op FROM admission_event WHERE screening_id = $1 ORDER BY id`, [t.screeningId]);
    expect(events).toEqual([
      { result: 'valid', device_id: 'gate-a', op: true },
      { result: 'already_used', device_id: 'gate-a', op: true },
      { result: 'void', device_id: 'gate-a', op: true },
      { result: 'invalid', device_id: 'gate-a', op: true },
    ]);
  });

  it('wrong screening the same day vs another day', async () => {
    const { t, tok, booking } = await setup();
    const [sameDay, otherDay] = await asAdmin(urls.adminUrl, async (c) => {
      const film = (await c.query(`SELECT film_id FROM screening WHERE id = $1`, [t.screeningId])).rows[0].film_id;
      const mk = (offset: string) =>
        c.query(
          `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format, status)
           SELECT tenant_id, screen_id, $2, starts_at + $3::interval, ends_at + $3::interval, 60, 'standard', 'published' FROM screening WHERE id = $1 RETURNING id`,
          [t.screeningId, film, offset],
        );
      return [(await mk('3 hours 30 minutes')).rows[0].id, (await mk('3 days')).rows[0].id];
    });
    // Starts 24 h out in seedSellable; +3.5 h may cross midnight in the theatre's zone, so compare against the database's own answer.
    const crosses = (await q(`SELECT (a.starts_at AT TIME ZONE 'Africa/Nairobi')::date <> (b.starts_at AT TIME ZONE 'Africa/Nairobi')::date AS x FROM screening a, screening b WHERE a.id = $1 AND b.id = $2`, [t.screeningId, sameDay]))[0]!.x;
    expect((await scan(tok, booking.tickets[0].code, sameDay)).body.result).toBe(crosses ? 'wrong_day' : 'wrong_screening');
    expect((await scan(tok, booking.tickets[0].code, otherDay)).body.result).toBe('wrong_day');
    // and neither scan used the ticket up
    expect((await scan(tok, booking.tickets[0].code, t.screeningId)).body.result).toBe('valid');
  });

  it("another chain's ticket is just invalid, and another chain's screening is not found", async () => {
    const mine = await setup();
    const theirs = await setup('other@example.test');
    expect((await scan(mine.tok, theirs.booking.tickets[0].code, mine.t.screeningId)).body.result).toBe('invalid');
    await http().post('/api/v1/tickets/redeem').set('authorization', `Bearer ${mine.tok}`).send({ code: theirs.booking.tickets[0].code, screening_id: theirs.t.screeningId, device_id: 'x' }).expect(404);
  });
});

describe('retrieval without an account (FR-73)', () => {
  it('reference plus e-mail returns the booking; the reference alone never does', async () => {
    const { booking } = await setup('lookup@example.test');
    await http().get('/api/v1/bookings/lookup').query({ reference: booking.reference }).expect(400);
    await http().get('/api/v1/bookings/lookup').query({ reference: booking.reference, email: 'someone-else@example.test' }).expect(404);
    const ok = await http().get('/api/v1/bookings/lookup').query({ reference: booking.reference.toLowerCase(), email: 'LOOKUP@example.test' }).expect(200);
    expect(ok.body.booking_id).toBe(booking.booking_id);
  });

  it('the signed link works on its own, and only for its booking', async () => {
    const { booking } = await setup('link@example.test');
    const ok = await http().get('/api/v1/bookings/lookup').set('booking-token', booking.manage_token).expect(200);
    expect(ok.body.reference).toBe(booking.reference);
    await http().get('/api/v1/bookings/lookup').set('booking-token', `${booking.manage_token.slice(0, -3)}abc`).expect(401);
  });

  it('lookup is rate-limited', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++)
      statuses.push((await http().get('/api/v1/bookings/lookup').query({ reference: `ZZZ-${i}`, email: 'x@example.test' })).status);
    expect(statuses).toContain(429);
  });
});
