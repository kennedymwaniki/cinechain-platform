import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD } from '../support/seed';
import { lockSeat, seedScreening } from '../support/seed-screening';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
const http = () => request(app.getHttpServer());
const T: Record<string, { id: string; slug: string }> = {};
let pub: Awaited<ReturnType<typeof seedScreening>>; // published, Nairobi, chain A
let draft: Awaited<ReturnType<typeof seedScreening>>;
let other: Awaited<ReturnType<typeof seedScreening>>; // published, Nairobi, chain B
let mombasa: Awaited<ReturnType<typeof seedScreening>>; // published, Mombasa, chain B
const HOLD = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  await asAdmin(urls.adminUrl, async (c) => {
    T.A = await createTenant(c);
    T.B = await createTenant(c);
    await addStaff(c, T.A.id, 'admin@public-a.test');
    pub = await seedScreening(c, T.A.id, { city: 'Nairobi', title: 'Avengers: Doomsday', seats: 6 });
    draft = await seedScreening(c, T.A.id, { city: 'Nairobi', title: 'Secret Draft', status: 'draft' });
    other = await seedScreening(c, T.B.id, { city: 'Nairobi', title: 'Avengers: Doomsday' });
    mombasa = await seedScreening(c, T.B.id, { city: 'Mombasa', title: 'Coastal 50%_Off' });
    await lockSeat(c, T.A.id, pub.screeningId, pub.seatIds[0]!, 'held', HOLD); // someone else's live hold
    await lockSeat(c, T.A.id, pub.screeningId, pub.seatIds[1]!, 'sold');
    await lockSeat(c, T.A.id, pub.screeningId, pub.seatIds[2]!, 'expired', HOLD);
    for (const id of other.seatIds) await lockSeat(c, T.B.id, other.screeningId, id, 'sold'); // sold out
  });
  app = await bootTestApp(urls);
});
afterAll(() => app.close());

describe('the sanctioned read doors (correction 5)', () => {
  it('resolve_published_screening works for the app role with NO app.tenant_id set', async () => {
    const c = new Client({ connectionString: urls.appUrl });
    await c.connect();
    try {
      expect((await c.query(`SELECT current_setting('app.tenant_id', true) AS g`)).rows[0].g ?? '').toBe('');
      const r = await c.query('SELECT tenant_id FROM resolve_published_screening($1)', [pub.screeningId]);
      expect(r.rows).toEqual([{ tenant_id: T.A!.id }]);
      // a draft and a non-existent screening are indistinguishable: no row
      expect((await c.query('SELECT * FROM resolve_published_screening($1)', [draft.screeningId])).rows).toEqual([]);
      expect((await c.query('SELECT * FROM resolve_published_screening($1)', ['00000000-0000-4000-8000-000000000000'])).rows).toEqual([]);
      // ...and the door opens nothing else: the tables stay closed
      expect((await c.query('SELECT count(*)::int AS n FROM screening')).rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
});

describe('seat map (public, masked)', () => {
  it('a guest with no token gets it, and every state is free | taken | yours', async () => {
    const res = await http().get(`/api/v1/screenings/${pub.screeningId}/seatmap`).expect(200);
    const states = [...new Set(res.body.seats.map((s: { state: string }) => s.state))].sort();
    expect(states.every((s) => ['free', 'taken', 'yours'].includes(s as string))).toBe(true);
    expect(res.text).not.toMatch(/"held"|"sold"|held|sold/i);
    expect(res.text).not.toContain(HOLD);
    expect(res.text).not.toContain(T.A!.id);
  });

  it('held-by-other and sold both read "taken"; an expired hold reads "free"; geometry kept', async () => {
    const seats = (await http().get(`/api/v1/screenings/${pub.screeningId}/seatmap`).expect(200)).body.seats;
    const state = (id: string) => seats.find((s: { id: string }) => s.id === id);
    expect(state(pub.seatIds[0]!)).toMatchObject({ state: 'taken', row: 'A', number: 1, x: 0, y: 0 });
    expect(state(pub.seatIds[1]!).state).toBe('taken');
    expect(state(pub.seatIds[2]!).state).toBe('free');
    expect(seats).toHaveLength(6); // inactive seats are not seats; taken ones are NOT omitted
  });

  it('a draft screening is a 404 byte-identical to one that does not exist', async () => {
    const d = await http().get(`/api/v1/screenings/${draft.screeningId}/seatmap`);
    const missing = await http().get('/api/v1/screenings/00000000-0000-4000-8000-000000000000/seatmap');
    expect(d.status).toBe(404);
    expect(d.text).toBe(missing.text);
  });

  it('a staff token is refused on the public seat map (wrong_token_type)', async () => {
    const staff = (await http().post('/api/v1/auth/staff/login').send({ email: 'admin@public-a.test', password: TEST_PASSWORD, tenant_slug: T.A!.slug }))
      .body.access_token;
    const res = await http().get(`/api/v1/screenings/${pub.screeningId}/seatmap`).set('authorization', `Bearer ${staff}`);
    expect([res.status, res.body.error]).toEqual([403, 'wrong_token_type']);
  });
});

describe('discovery (cross-chain, poster data only)', () => {
  it('lists published films from EVERY chain in a town, and nothing else', async () => {
    const res = await http().get('/api/v1/discover/films?city=nairobi').expect(200);
    const chains = res.body.map((f: { chain: { slug: string } }) => f.chain.slug).sort();
    expect(chains).toEqual([T.A!.slug, T.B!.slug].sort());
    expect(res.text).not.toContain('Secret Draft');
    expect(res.text).not.toContain('Coastal'); // Mombasa
    for (const id of [T.A!.id, T.B!.id]) expect(res.text).not.toContain(id); // tenant ids never leave the server
  });

  it('title search treats % and _ literally', async () => {
    const hit = (await http().get('/api/v1/discover/films?city=Mombasa&title=50%25_Off').expect(200)).body;
    expect(hit.map((f: { film: { id: string } }) => f.film.id)).toEqual([mombasa.filmId]);
    expect((await http().get('/api/v1/discover/films?city=Mombasa&title=5_%25').expect(200)).body).toHaveLength(0);
  });

  it("a film's screenings are grouped by theatre with a sold-out mark and no counts", async () => {
    const res = await http().get(`/api/v1/discover/films/${other.filmId}/screenings`).expect(200);
    expect(res.body.theatres).toHaveLength(1);
    expect(res.body.theatres[0].screenings).toEqual([expect.objectContaining({ id: other.screeningId, sold_out: true })]);
    expect(res.text).not.toMatch(/seats_left|available|taken|capacity/);
    const notFull = await http().get(`/api/v1/discover/films/${pub.filmId}/screenings`).expect(200);
    expect(notFull.body.theatres[0].screenings[0].sold_out).toBe(false);
  });

  it("a draft film's screenings are a 404", async () => {
    await http().get(`/api/v1/discover/films/${draft.filmId}/screenings`).expect(404);
  });

  it("a suspended chain's showtimes disappear", async () => {
    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE tenant SET status = 'suspended' WHERE id = $1`, [T.B!.id]));
    try {
      const res = await http().get('/api/v1/discover/films?city=nairobi').expect(200);
      expect(res.body.map((f: { chain: { slug: string } }) => f.chain.slug)).toEqual([T.A!.slug]);
      await http().get(`/api/v1/screenings/${other.screeningId}/seatmap`).expect(404);
    } finally {
      await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE tenant SET status = 'active' WHERE id = $1`, [T.B!.id]));
    }
  });
});

describe('FR-14: the layout is locked once future seats are sold', () => {
  it('refuses to change a seat or regenerate while a future screening has a sold seat', async () => {
    const tok = (await http().post('/api/v1/auth/staff/login').send({ email: 'admin@public-a.test', password: TEST_PASSWORD, tenant_slug: T.A!.slug }))
      .body.access_token;
    const res = await http().patch(`/api/v1/seats/${pub.seatIds[4]}`).set('authorization', `Bearer ${tok}`).send({ is_active: false });
    expect([res.status, res.body.error]).toEqual([409, 'layout_locked']);
    // a screen with no sales is still editable
    await http().patch(`/api/v1/seats/${draft.seatIds[0]}`).set('authorization', `Bearer ${tok}`).send({ seat_class: 'vip' }).expect(200);
  });
});
