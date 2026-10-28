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
let tokA: string;
let tokB: string;
const http = () => request(app.getHttpServer());
const as = (t: string) => ({ authorization: `Bearer ${t}` });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

beforeAll(async () => {
  A = await seedVenueTenant(urls.adminUrl, 'cat-a');
  B = await seedVenueTenant(urls.adminUrl, 'cat-b');
  app = await bootTestApp(urls);
  const login = (e: string, s: string) => http().post('/api/v1/auth/staff/login').send({ email: e, password: TEST_PASSWORD, tenant_slug: s });
  tokA = (await login(A.adminEmail, A.slug)).body.access_token;
  tokB = (await login(B.adminEmail, B.slug)).body.access_token;
});
afterAll(() => app.close());

describe('films', () => {
  it('two chains may both list "Avengers: Doomsday" with no conflict', async () => {
    const body = { title: 'Avengers: Doomsday', runtime_min: 150, rating: 'PG', language: 'English', release_date: '2026-12-18' };
    const a = await http().post('/api/v1/films').set(as(tokA)).send(body).expect(201);
    const b = await http().post('/api/v1/films').set(as(tokB)).send(body).expect(201);
    expect(a.body.id).not.toBe(b.body.id);
    const listA = await http().get('/api/v1/films').set(as(tokA)).expect(200);
    expect(listA.text).not.toContain(b.body.id);
  });

  it('pages with an opaque cursor', async () => {
    for (const t of ['Alpha', 'Bravo', 'Charlie']) await http().post('/api/v1/films').set(as(tokA)).send({ title: t, runtime_min: 90 }).expect(201);
    const p1 = await http().get('/api/v1/films?limit=2').set(as(tokA)).expect(200);
    const p2 = await http().get(`/api/v1/films?limit=2&cursor=${p1.body.next_cursor}`).set(as(tokA)).expect(200);
    const titles = [...p1.body.items, ...p2.body.items].map((f: { title: string }) => f.title);
    expect(titles.slice(0, 4)).toEqual(['Alpha', 'Avengers: Doomsday', 'Bravo', 'Charlie']);
  });

  it('a poster is checked by its bytes, not its claimed type or name', async () => {
    const f = await http().post('/api/v1/films').set(as(tokA)).send({ title: 'Poster Test', runtime_min: 100 }).expect(201);
    const fake = await http()
      .post(`/api/v1/films/${f.body.id}/poster`)
      .set(as(tokA))
      .attach('poster', Buffer.from('<?php system($_GET[1]); ?>'.padEnd(64)), { filename: 'evil.png', contentType: 'image/png' });
    expect([fake.status, fake.body.error]).toEqual([400, 'poster_type']);
    const big = await http()
      .post(`/api/v1/films/${f.body.id}/poster`)
      .set(as(tokA))
      .attach('poster', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), { filename: 'big.png', contentType: 'image/png' });
    // refused by the upload limiter before the bytes are even buffered in full
    expect([big.status, big.body.error]).toEqual([413, 'payload_too_large']);
  });
});

describe('pricing', () => {
  it('a price cannot start in the past (never retroactive)', async () => {
    const res = await http()
      .post('/api/v1/pricing-rules')
      .set(as(tokA))
      .send({ seat_class: 'standard', price_minor: 70000, effective_from: '2026-01-01T00:00:00Z' });
    expect([res.status, res.body.error]).toEqual([400, 'retroactive_price']);
  });

  it('a new price closes the current one at its start; history is kept', async () => {
    const first = await http().post('/api/v1/pricing-rules').set(as(tokA)).send({ seat_class: 'vip', price_minor: 120000 }).expect(201);
    expect(first.body.price).toEqual({ amount_minor: 120000, currency: 'KES' });
    const from = new Date(Date.now() + 3600_000).toISOString();
    await http().post('/api/v1/pricing-rules').set(as(tokA)).send({ seat_class: 'vip', price_minor: 140000, effective_from: from }).expect(201);
    const rules = (await http().get('/api/v1/pricing-rules').set(as(tokA)).expect(200)).body.filter((r: { seat_class: string }) => r.seat_class === 'vip');
    expect(rules).toHaveLength(2);
    const closed = rules.find((r: { id: string }) => r.id === first.body.id);
    expect(new Date(closed.effective_to).toISOString()).toBe(from);
  });

  it('the DATABASE refuses two overlapping rules for one class, even bypassing the service', async () => {
    const err = await asAdmin(urls.adminUrl, (c) =>
      c
        .query(
          `INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from)
           VALUES ($1, 'companion', 1, 'KES', now()), ($1, 'companion', 2, 'KES', now() + interval '1 hour')`,
          [A.id],
        )
        .then(() => null, (e: { code: string }) => e.code),
    );
    expect(err).toBe('23P01');
  });

  it('rejects a float price', async () => {
    const res = await http().post('/api/v1/pricing-rules').set(as(tokA)).send({ seat_class: 'accessible', price_minor: 650.5 });
    expect(res.status).toBe(400);
  });
});
