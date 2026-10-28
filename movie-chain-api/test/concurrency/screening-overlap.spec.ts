/**
 * FR-22 under concurrency. There is no application-level overlap pre-check at
 * all (see ScreeningService.create), so this passes ONLY because the database
 * exclusion constraint is the mechanism.
 */
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedVenueTenant, type VenueTenant } from '../isolation/helpers/seed-venue-tenant';
import { TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';
import { race } from './harness';

const urls = inject('db');
let app: INestApplication;
let A: VenueTenant;
let tok: string;
let filmId: string;

beforeAll(async () => {
  A = await seedVenueTenant(urls.adminUrl, 'race');
  app = await bootTestApp(urls, { env: { DATABASE_POOL_MAX: '30' } });
  tok = (await request(app.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: A.adminEmail, password: TEST_PASSWORD, tenant_slug: A.slug }))
    .body.access_token;
  filmId = (
    await request(app.getHttpServer()).post('/api/v1/films').set({ authorization: `Bearer ${tok}` }).send({ title: 'Race', runtime_min: 120 }).expect(201)
  ).body.id;
});
afterAll(() => app.close());

describe('concurrent scheduling', () => {
  it('two simultaneous overlapping POSTs: exactly one 201 and one 409, ten rounds in a row', async () => {
    for (let round = 0; round < 10; round++) {
      const base = Date.UTC(2027, 5, 1 + round, 10);
      const results = await race(2, (i) => () =>
        request(app.getHttpServer())
          .post('/api/v1/screenings')
          .set({ authorization: `Bearer ${tok}` })
          .send({ screen_id: A.screenId, film_id: filmId, starts_at: new Date(base + i * 30 * 60_000).toISOString() }),
      );
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error).toBe('screening_overlap');
    }
  });

  it('twenty simultaneous POSTs for the same slot: exactly one winner', async () => {
    const startsAt = new Date(Date.UTC(2027, 6, 1, 18)).toISOString();
    const results = await race(20, () => () =>
      request(app.getHttpServer())
        .post('/api/v1/screenings')
        .set({ authorization: `Bearer ${tok}` })
        .send({ screen_id: A.screenId, film_id: filmId, starts_at: startsAt }),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
  });

  it('the guarantee holds below the application: two raw transactions, no service code at all', async () => {
    const [c1, c2] = [new Client({ connectionString: urls.adminUrl }), new Client({ connectionString: urls.adminUrl })];
    await Promise.all([c1.connect(), c2.connect()]);
    try {
      const insert = (c: Client, hh: number) =>
        c.query(
          `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format)
           VALUES ($1, $2, $3, $4, $4::timestamptz + interval '2 hours', 60, 'standard')`,
          [A.id, A.screenId, filmId, new Date(Date.UTC(2027, 7, 1, hh)).toISOString()],
        );
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await insert(c1, 10);
      const second = insert(c2, 11); // blocks on c1's uncommitted row
      await c1.query('COMMIT');
      await expect(second).rejects.toMatchObject({ code: '23P01', constraint: 'no_screen_overlap' });
      await c2.query('ROLLBACK');
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }
  });
});
