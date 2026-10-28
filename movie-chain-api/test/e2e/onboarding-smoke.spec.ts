/**
 * THE deploy smoke test. Onboarding touches identity, data and permissions in
 * one pass, so "create a throwaway tenant, use it, delete it" is the single
 * most informative check this system has. Runs on every deploy.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { StaffInviteMailer } from '../../src/staff/staff-invite.mailer';
import { addOperator, asAdmin, TEST_PASSWORD } from '../support/seed';
import { waitForStatus } from '../support/onboarding';
import { bootControlApp, bootTestApp } from '../support/test-app';

const urls = inject('db');
const redisUrl = inject('redisUrl');
let api: INestApplication;
let control: INestApplication;
let operatorToken: string;

beforeAll(async () => {
  await asAdmin(urls.adminUrl, (c) => addOperator(c, 'ops@smoke.test'));
  control = await bootControlApp(urls, redisUrl);
  api = await bootTestApp(urls);
  operatorToken = (
    await request(control.getHttpServer()).post('/admin/auth/login').send({ email: 'ops@smoke.test', password: TEST_PASSWORD }).expect(200)
  ).body.access_token;
});
afterAll(async () => {
  await api?.close();
  await control?.close();
});

describe('onboarding smoke', () => {
  it('creates a throwaway tenant, uses it, and deletes it', async () => {
    const slug = `smoke-${Date.now().toString(36)}`;
    const started = Date.now();
    const created = await request(control.getHttpServer())
      .post('/admin/tenants')
      .set('authorization', `Bearer ${operatorToken}`)
      .send({ name: 'Smoke Cinemas', slug, contactEmail: `admin@${slug}.test` })
      .expect(202);
    const tenantId = created.body.tenant_id as string;

    const status = await waitForStatus(control, operatorToken, tenantId, ['active']);
    expect(Date.now() - started).toBeLessThan(60_000); // FR-2
    expect(status.steps.every((s: { status: string }) => s.status === 'done')).toBe(true);
    expect(status.steps.map((s: { name: string }) => s.name)).toContain('seed_sample_theatre');

    // identity: the activation link works once, and the admin can sign in
    const token = control.get(StaffInviteMailer).outbox.get(`admin@${slug}.test`)!;
    await request(api.getHttpServer())
      .post('/api/v1/auth/staff/activate')
      .send({ tenant_slug: slug, token, password: 'smoke-password-123' })
      .expect(204);
    const login = await request(api.getHttpServer())
      .post('/api/v1/auth/staff/login')
      .send({ email: `admin@${slug}.test`, password: 'smoke-password-123', tenant_slug: slug })
      .expect(200);
    const me = await request(api.getHttpServer()).get('/api/v1/auth/staff/me').set('authorization', `Bearer ${login.body.access_token}`).expect(200);
    expect(me.body).toMatchObject({ role: 'chain_admin', tenant: { id: tenantId, slug } });

    // delete it: nothing of the tenant survives
    await request(control.getHttpServer()).delete(`/admin/tenants/${tenantId}`).set('authorization', `Bearer ${operatorToken}`).expect(200);
    const left = await asAdmin(urls.adminUrl, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM tenant WHERE id = $1)::int AS tenant,
                (SELECT count(*) FROM staff_user WHERE tenant_id = $1)::int AS staff,
                (SELECT count(*) FROM staff_activation WHERE tenant_id = $1)::int AS activation,
                (SELECT count(*) FROM theatre WHERE tenant_id = $1)::int AS theatres,
                (SELECT count(*) FROM seat WHERE tenant_id = $1)::int AS seats`,
        [tenantId],
      ),
    );
    expect(left.rows[0]).toEqual({ tenant: 0, staff: 0, activation: 0, theatres: 0, seats: 0 });
  });

  it('requires an operator token; a staff token is refused', async () => {
    await request(control.getHttpServer()).post('/admin/tenants').send({}).expect(401);
  });
});
