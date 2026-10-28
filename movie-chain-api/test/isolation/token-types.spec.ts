import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { LogVerificationMailer } from '../../src/identity/verification-mailer';
import { ConsumerGuard, type ConsumerRequest } from '../../src/tenancy/consumer.guard';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD, type SeededTenant } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
let A: SeededTenant;
let staffToken: string;
let consumerToken: string;
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  A = await asAdmin(urls.adminUrl, async (c) => {
    const t = await createTenant(c);
    await addStaff(c, t.id, 'clerk@a.test', 'box_office');
    return t;
  });
  app = await bootTestApp(urls);
  staffToken = (await http().post('/api/v1/auth/staff/login').send({ email: 'clerk@a.test', password: TEST_PASSWORD, tenant_slug: A.slug }))
    .body.access_token;
  await http().post('/api/v1/auth/register').send({ email: 'grace@tokens.test', password: 'grace-password-1' }).expect(202);
  consumerToken = (await http().post('/api/v1/auth/login').send({ email: 'grace@tokens.test', password: 'grace-password-1' }).expect(200))
    .body.access_token;
});
afterAll(() => app.close());

describe('token types are mutually exclusive', () => {
  it('a consumer JWT has no tenant_id key at all', () => {
    const c = claims(consumerToken);
    expect(Object.keys(c)).not.toContain('tenant_id');
    expect(c).toMatchObject({ typ: 'consumer', aud: 'consumer-v1' });
  });

  it('a staff token on a consumer endpoint → 403 wrong_token_type, and it is recorded', async () => {
    const res = await http().get('/api/v1/me').set('authorization', `Bearer ${staffToken}`);
    expect([res.status, res.body.error]).toEqual([403, 'wrong_token_type']);
    const n = await asAdmin(urls.adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM platform.security_event WHERE kind = 'wrong_token_type'`),
    );
    expect(n.rows[0].n).toBeGreaterThan(0);
  });

  it('a consumer token on a staff endpoint → 401 no_tenant_context', async () => {
    const res = await http().get('/api/v1/auth/staff/me').set('authorization', `Bearer ${consumerToken}`);
    expect([res.status, res.body.error]).toEqual([401, 'no_tenant_context']);
  });

  it('a staff-signed token re-labelled typ=consumer still fails: the keys differ', async () => {
    // Even if a guard trusted `typ`, a staff-v1 signature cannot verify under consumer-v1.
    const [h, , s] = staffToken.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims(staffToken), typ: 'consumer', tenant_id: undefined })).toString('base64url')}.${s}`;
    const res = await http().get('/api/v1/me').set('authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('a guest with no Authorization header passes ConsumerGuard with consumer = null', async () => {
    // /me requires an account, so the guest path is exercised through the guard directly.
    const guard = app.get(ConsumerGuard);
    const req = { path: '/x', headers: {} } as ConsumerRequest;
    await expect(guard.check(req, null, false)).resolves.toBe(true);
    expect(req.consumer).toBeNull();
    await expect(guard.check(req, null, true)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('consumer registration', () => {
  it('does not reveal whether an e-mail is registered, and never overwrites the password', async () => {
    const again = await http().post('/api/v1/auth/register').send({ email: 'grace@tokens.test', password: 'attacker-password' });
    expect([again.status, again.body]).toEqual([202, { status: 'verification_sent' }]);
    await http().post('/api/v1/auth/login').send({ email: 'grace@tokens.test', password: 'attacker-password' }).expect(401);
    await http().post('/api/v1/auth/login').send({ email: 'grace@tokens.test', password: 'grace-password-1' }).expect(200);
  });

  it('verification is single-use and emits consumer.verified exactly once', async () => {
    const mailer = app.get(LogVerificationMailer);
    await http().post('/api/v1/auth/register').send({ email: 'verify@tokens.test', password: 'verify-password-1' }).expect(202);
    const token = new URL(mailer.outbox.get('verify@tokens.test')!).searchParams.get('token')!;
    await http().post('/api/v1/auth/verify-email').send({ token }).expect(200);
    await http().post('/api/v1/auth/verify-email').send({ token }).expect(400);
    const events = await asAdmin(urls.adminUrl, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM platform.identity_outbox o JOIN platform.consumer k ON k.id = (o.payload->>'consumerId')::uuid
          WHERE o.kind = 'consumer.verified' AND k.email = 'verify@tokens.test'`,
      ),
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('Google sign-in is cleanly disabled when the env trio is absent', async () => {
    await http().get('/api/v1/auth/google').expect(404);
    await http().get('/api/v1/auth/google/callback').expect(404);
  });
});
