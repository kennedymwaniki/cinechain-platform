import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD, type SeededTenant } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
let A: SeededTenant;
let B: SeededTenant;
let staffB: string;

const login = (email: string, slug: string, password = TEST_PASSWORD) =>
  request(app.getHttpServer()).post('/api/v1/auth/staff/login').send({ email, password, tenant_slug: slug });
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());

beforeAll(async () => {
  await asAdmin(urls.adminUrl, async (c) => {
    A = await createTenant(c);
    B = await createTenant(c);
    await addStaff(c, A.id, 'admin@a.test');
    staffB = await addStaff(c, B.id, 'admin@b.test');
    // The same e-mail at both chains: two separate accounts (PRD §4.2).
    await addStaff(c, A.id, 'both@shared.test', 'box_office');
    await addStaff(c, B.id, 'both@shared.test', 'box_office');
  });
  app = await bootTestApp(urls);
});
afterAll(() => app.close());

describe('staff authentication', () => {
  it('issues a staff token carrying tenant_id and typ=staff', async () => {
    const res = await login('admin@a.test', A.slug).expect(200);
    const c = claims(res.body.access_token);
    expect(c).toMatchObject({ typ: 'staff', tenant_id: A.id, tenant_slug: A.slug, aud: 'staff-v1' });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/);
  });

  it('the same e-mail at two chains logs into whichever chain is named', async () => {
    const a = await login('both@shared.test', A.slug).expect(200);
    const b = await login('both@shared.test', B.slug).expect(200);
    expect(claims(a.body.access_token).tenant_id).toBe(A.id);
    expect(claims(b.body.access_token).tenant_id).toBe(B.id);
  });

  it('a chain-A user cannot log in by naming chain B', async () => {
    await login('admin@a.test', B.slug).expect(401);
  });

  it('wrong password, unknown user and unknown tenant are indistinguishable', async () => {
    const bodies = await Promise.all([
      login('admin@a.test', A.slug, 'nope'),
      login('ghost@a.test', A.slug, 'nope'),
      login('admin@a.test', 'no-such-chain', 'nope'),
    ]);
    for (const r of bodies) expect([r.status, r.body.error]).toEqual([401, 'invalid_credentials']);
  });

  it('rejects an unexpected tenant_id field in the login body', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/staff/login')
      .send({ email: 'admin@a.test', password: TEST_PASSWORD, tenant_slug: A.slug, tenant_id: B.id })
      .expect(400);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const first = (await login('admin@a.test', A.slug).expect(200)).body.refresh_token;
    const second = (await request(app.getHttpServer()).post('/api/v1/auth/staff/refresh').send({ refresh_token: first }).expect(200))
      .body.refresh_token;
    // replaying the rotated token is theft: 401, and the live token dies too
    await request(app.getHttpServer()).post('/api/v1/auth/staff/refresh').send({ refresh_token: first }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/staff/refresh').send({ refresh_token: second }).expect(401);
    const n = await asAdmin(urls.adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM platform.security_event WHERE kind = 'refresh_token_reuse'`),
    );
    expect(n.rows[0].n).toBeGreaterThan(0);
  });

  it('a bumped session_version ends the session at the next refresh', async () => {
    const rt = (await login('admin@a.test', A.slug).expect(200)).body.refresh_token;
    await asAdmin(urls.adminUrl, (c) =>
      c.query(`UPDATE staff_user SET session_version = session_version + 1 WHERE email = 'admin@a.test' AND tenant_id = $1`, [A.id]),
    );
    const res = await request(app.getHttpServer()).post('/api/v1/auth/staff/refresh').send({ refresh_token: rt }).expect(401);
    expect(res.body.error).toBe('session_revoked');
  });
});

describe('cross-tenant access', () => {
  it("a tenant-A token against a tenant-B staff id returns 404, never 403", async () => {
    const at = (await login('admin@a.test', A.slug).expect(200)).body.access_token;
    const res = await request(app.getHttpServer()).get(`/api/v1/staff/${staffB}`).set('authorization', `Bearer ${at}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Resource not found' });
  });

  it('the cross-tenant 404 is byte-identical to a genuinely missing id', async () => {
    const at = (await login('admin@a.test', A.slug).expect(200)).body.access_token;
    const other = await request(app.getHttpServer()).get(`/api/v1/staff/${staffB}`).set('authorization', `Bearer ${at}`);
    const missing = await request(app.getHttpServer())
      .get('/api/v1/staff/00000000-0000-4000-8000-000000000000')
      .set('authorization', `Bearer ${at}`);
    expect(other.text).toBe(missing.text);
  });

  it('a token for a suspended tenant is rejected in the interceptor', async () => {
    const S = await asAdmin(urls.adminUrl, async (c) => {
      const t = await createTenant(c);
      await addStaff(c, t.id, 'admin@s.test');
      return t;
    });
    const at = (await login('admin@s.test', S.slug).expect(200)).body.access_token;
    await asAdmin(urls.adminUrl, (c) => c.query(`UPDATE tenant SET status = 'suspended' WHERE id = $1`, [S.id]));
    // The registry caches for 15 s; a fresh app has a cold cache.
    const fresh = await bootTestApp(urls);
    try {
      const res = await request(fresh.getHttpServer()).get('/api/v1/auth/staff/me').set('authorization', `Bearer ${at}`);
      expect([res.status, res.body.error]).toEqual([403, 'tenant_suspended']);
    } finally {
      await fresh.close();
    }
  });
});
