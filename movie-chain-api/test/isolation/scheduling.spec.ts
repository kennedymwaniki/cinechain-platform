import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';
import { seedVenueTenant, type VenueTenant } from './helpers/seed-venue-tenant';

const urls = inject('db');
let app: INestApplication;
let A: VenueTenant;
let B: VenueTenant;
let tok: string;
let filmId: string; // 100-minute film in tenant A
let bFilmId: string;
const http = () => request(app.getHttpServer());
const auth = () => ({ authorization: `Bearer ${tok}` });

/** A fixed future day, at a given UTC hour/minute (Nairobi = UTC+3, no DST). */
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2027, 2, day, hh, mm)).toISOString();
const schedule = (screen: string, startsAt: string, film = filmId) =>
  http().post('/api/v1/screenings').set(auth()).send({ screen_id: screen, film_id: film, starts_at: startsAt });

beforeAll(async () => {
  A = await seedVenueTenant(urls.adminUrl, 'sched-a');
  B = await seedVenueTenant(urls.adminUrl, 'sched-b');
  app = await bootTestApp(urls);
  tok = (await http().post('/api/v1/auth/staff/login').send({ email: A.adminEmail, password: TEST_PASSWORD, tenant_slug: A.slug })).body.access_token;
  filmId = (await http().post('/api/v1/films').set(auth()).send({ title: 'Doomsday', runtime_min: 100 }).expect(201)).body.id;
  bFilmId = await asAdmin(urls.adminUrl, async (c) =>
    (await c.query(`INSERT INTO film (tenant_id, title, runtime_min) VALUES ($1, 'B', 90) RETURNING id`, [B.id])).rows[0].id,
  );
});
afterAll(() => app.close());

describe('the overlap constraint, including turnaround', () => {
  it('ends_at comes from the runtime, and at least ONE HOUR of cleaning blocks the screen after it', async () => {
    const first = await schedule(A.screenId, at(1, 17, 0)).expect(201); // 17:00–18:40, blocked until 19:40
    expect(new Date(first.body.ends_at).toISOString()).toBe(at(1, 18, 40));
    expect(first.body.turnaround_minutes).toBe(60);
    expect(new Date(first.body.blocked_until).toISOString()).toBe(at(1, 19, 40));
    for (const t of [at(1, 18, 50), at(1, 19, 39)]) {
      const r = await schedule(A.screenId, t);
      expect([r.status, r.body.error], t).toEqual([409, 'screening_overlap']);
    }
    await schedule(A.screenId, at(1, 19, 40)).expect(201); // exactly one hour after the end: fine
  });

  it('the same time on a DIFFERENT screen is fine', async () => {
    await schedule(A.otherScreenId, at(1, 17, 0)).expect(201);
  });

  it('a chain may choose a LONGER turnaround (copied at creation), never shorter than an hour', async () => {
    const below = await asAdmin(urls.adminUrl, (c) =>
      c.query(`UPDATE tenant SET turnaround_minutes = 30 WHERE id = $1`, [A.id]).then(() => null, (e: { code: string }) => e.code),
    );
    expect(below).toBe('23514'); // the database refuses less than 60

    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE tenant SET turnaround_minutes = 90 WHERE id = $1`, [A.id]));
    const fresh = await bootTestApp(urls); // the registry caches tenant config for 15 s
    try {
      const t = (await request(fresh.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: A.adminEmail, password: TEST_PASSWORD, tenant_slug: A.slug }))
        .body.access_token;
      const post = (startsAt: string) =>
        request(fresh.getHttpServer())
          .post('/api/v1/screenings')
          .set({ authorization: `Bearer ${t}` })
          .send({ screen_id: A.screenId, film_id: filmId, starts_at: startsAt });
      const a = await post(at(2, 10, 0)).expect(201); // 10:00–11:40, blocked until 13:10
      expect(a.body.turnaround_minutes).toBe(90);
      await post(at(2, 12, 40)).expect(409); // an hour would allow this; this chain chose 90 minutes
      await post(at(2, 13, 10)).expect(201);
    } finally {
      await fresh.close();
      await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE tenant SET turnaround_minutes = 60 WHERE id = $1`, [A.id]));
    }
  });

  it('the database refuses a screening with less than an hour of turnaround, even bypassing the service', async () => {
    const code = await asAdmin(urls.adminUrl, (c) =>
      c
        .query(
          `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format)
           VALUES ($1, $2, $3, $4, $4::timestamptz + interval '2 hours', 20, 'standard')`,
          [A.id, A.otherScreenId, filmId, at(20, 9, 0)],
        )
        .then(() => null, (e: { code: string }) => e.code),
    );
    expect(code).toBe('23514');
  });

  it('a cancelled screening frees its slot', async () => {
    const s = await schedule(A.screenId, at(3, 12, 0)).expect(201);
    await schedule(A.screenId, at(3, 12, 30)).expect(409);
    await http().post(`/api/v1/screenings/${s.body.id}/cancel`).set(auth()).expect(200);
    await schedule(A.screenId, at(3, 12, 30)).expect(201);
  });

  it("refuses another chain's film on our own screen (404)", async () => {
    await schedule(A.screenId, at(4, 12, 0), bFilmId).expect(404);
  });

  it('refuses a start in the past', async () => {
    const r = await schedule(A.screenId, new Date(Date.now() - 60_000).toISOString());
    expect([r.status, r.body.error]).toEqual([400, 'starts_in_past']);
  });
});

describe('where the cleaning time comes from: screening → screen → chain', () => {
  const blockedMinutes = (b: { ends_at: string; blocked_until: string }) =>
    (Date.parse(b.blocked_until) - Date.parse(b.ends_at)) / 60_000;

  it("a screen with no default of its own uses the chain's (60)", async () => {
    const r = await schedule(A.otherScreenId, at(11, 9, 0)).expect(201);
    expect([r.body.turnaround_minutes, blockedMinutes(r.body)]).toEqual([60, 60]);
  });

  it("a screen's own default beats the chain's", async () => {
    const sc = await http().post('/api/v1/screens').set(auth()).send({ theatre_id: A.theatreId, name: 'IMAX', turnaround_minutes: 90 }).expect(201);
    expect(sc.body.turnaround_minutes).toBe(90);
    const r = await schedule(sc.body.id, at(12, 9, 0)).expect(201);
    expect([r.body.turnaround_minutes, blockedMinutes(r.body)]).toEqual([90, 90]);
  });

  it("a value given for one screening beats both — and the next start is any time after it", async () => {
    const r = await http()
      .post('/api/v1/screenings')
      .set(auth())
      .send({ screen_id: A.otherScreenId, film_id: filmId, starts_at: at(13, 9, 0), turnaround_minutes: 120 }) // premiere deep clean
      .expect(201);
    expect(r.body.turnaround_minutes).toBe(120); // 9:00–10:40, blocked until 12:40
    await schedule(A.otherScreenId, at(13, 12, 39)).expect(409);
    await schedule(A.otherScreenId, at(13, 15, 5)).expect(201); // any start after the gap is the scheduler's choice
  });

  it('under an hour is refused at every level', async () => {
    const one = await http()
      .post('/api/v1/screenings')
      .set(auth())
      .send({ screen_id: A.otherScreenId, film_id: filmId, starts_at: at(14, 9, 0), turnaround_minutes: 30 });
    expect(one.status).toBe(400);
    await http().post('/api/v1/screens').set(auth()).send({ theatre_id: A.theatreId, name: 'Quick', turnaround_minutes: 45 }).expect(400);
    await http().patch(`/api/v1/screens/${A.otherScreenId}`).set(auth()).send({ turnaround_minutes: 59 }).expect(400);
  });

  it("changing a screen's default only affects screenings created afterwards", async () => {
    const sc = (await http().post('/api/v1/screens').set(auth()).send({ theatre_id: A.theatreId, name: 'Hall 7' }).expect(201)).body.id;
    const before = (await schedule(sc, at(15, 9, 0)).expect(201)).body;
    await http().patch(`/api/v1/screens/${sc}`).set(auth()).send({ turnaround_minutes: 150 }).expect(200);
    const kept = (await http().get(`/api/v1/screenings/${before.id}`).set(auth()).expect(200)).body;
    expect(kept.turnaround_minutes).toBe(60); // the scheduled one keeps its copy
    expect((await schedule(sc, at(16, 9, 0)).expect(201)).body.turnaround_minutes).toBe(150);
    // and back to "use the chain's default"
    const reset = await http().patch(`/api/v1/screens/${sc}`).set(auth()).send({ turnaround_minutes: null }).expect(200);
    expect(reset.body.turnaround_minutes).toBeNull();
  });
});

describe('lifecycle', () => {
  it('DRAFT → PUBLISHED → CLOSED → COMPLETED; illegal moves are 409', async () => {
    const s = (await schedule(A.screenId, at(5, 12, 0)).expect(201)).body.id;
    await http().post(`/api/v1/screenings/${s}/close`).set(auth()).expect(409); // cannot skip publish
    await http().post(`/api/v1/screenings/${s}/publish`).set(auth()).expect(200);
    await http().post(`/api/v1/screenings/${s}/publish`).set(auth()).expect(409);
    await http().post(`/api/v1/screenings/${s}/close`).set(auth()).expect(200);
    await http().post(`/api/v1/screenings/${s}/complete`).set(auth()).expect(200);
    const r = await http().post(`/api/v1/screenings/${s}/cancel`).set(auth());
    expect([r.status, r.body.error]).toEqual([409, 'invalid_transition']);
  });

  it('cannot publish on a screen with no seats', async () => {
    const sc = (await http().post('/api/v1/screens').set(auth()).send({ theatre_id: A.theatreId, name: 'Empty' }).expect(201)).body.id;
    const s = (await schedule(sc, at(6, 12, 0)).expect(201)).body.id;
    const r = await http().post(`/api/v1/screenings/${s}/publish`).set(auth());
    expect([r.status, r.body.error]).toEqual([409, 'no_seats']);
  });
});

describe('FR-15: screens out of service', () => {
  it('lists affected screenings, refuses new scheduling and publishing, and does not auto-cancel', async () => {
    const sc = (await http().post('/api/v1/screens').set(auth()).send({ theatre_id: A.theatreId, name: 'Repair' }).expect(201)).body.id;
    await asAdmin(urls.adminUrl, (c) =>
      c.query(`INSERT INTO seat (tenant_id, screen_id, row_label, seat_number, row_index, col_index) VALUES ($1, $2, 'A', 1, 0, 0)`, [A.id, sc]),
    );
    const s = (await schedule(sc, at(7, 12, 0)).expect(201)).body.id;
    const off = await http().post(`/api/v1/screens/${sc}/out-of-service`).set(auth()).send({ reason: 'sound system' }).expect(200);
    expect(off.body.affected_screenings.map((x: { id: string }) => x.id)).toEqual([s]);
    expect((await schedule(sc, at(8, 12, 0))).body.error).toBe('screen_out_of_service');
    expect((await http().post(`/api/v1/screenings/${s}/publish`).set(auth())).body.error).toBe('screen_out_of_service');
    expect((await http().get(`/api/v1/screenings/${s}`).set(auth())).body.status).toBe('draft'); // not cancelled
  });
});

describe('FR-24: copy a day forward', () => {
  it('copies as drafts at the same LOCAL time, skipping collisions instead of failing the copy', async () => {
    const day = 10;
    await schedule(A.otherScreenId, at(day, 9, 0)).expect(201); // 12:00 Nairobi
    await schedule(A.otherScreenId, at(day, 13, 0)).expect(201); // 16:00 Nairobi
    await schedule(A.otherScreenId, at(day + 7, 13, 30)).expect(201); // already occupies the target slot
    const r = await http()
      .post('/api/v1/screenings:copy')
      .set(auth())
      .send({ theatre_id: A.otherTheatreId, from_date: '2027-03-10', to_date: '2027-03-17', span: 'day' })
      .expect(201);
    expect(r.body.created).toBe(1);
    expect(r.body.skipped).toEqual([expect.objectContaining({ reason: 'screening_overlap' })]);
    const copy = await http().get(`/api/v1/screenings/${r.body.created_ids[0]}`).set(auth()).expect(200);
    expect([new Date(copy.body.starts_at).toISOString(), copy.body.status]).toEqual([at(day + 7, 9, 0), 'draft']);
  });

  it("copying another chain's theatre is a 404", async () => {
    await http()
      .post('/api/v1/screenings:copy')
      .set(auth())
      .send({ theatre_id: B.theatreId, from_date: '2027-03-10', to_date: '2027-03-17', span: 'day' })
      .expect(404);
  });
});
