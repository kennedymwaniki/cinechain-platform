import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OnboardingService } from '../../src/control/onboarding/onboarding.service';
import { ONBOARDING_STEPS } from '../../src/control/onboarding/onboarding.steps';
import { addOperator, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootControlApp } from '../support/test-app';
import { waitForStatus } from '../support/onboarding';

const urls = inject('db');
const redisUrl = inject('redisUrl');
let control: INestApplication;
let token: string;

const countsFor = (tenantId: string) =>
  asAdmin(urls.adminUrl, (c) =>
    c.query(
      `SELECT (SELECT count(*) FROM tenant WHERE id = $1)::int AS tenant,
              (SELECT count(*) FROM staff_user WHERE tenant_id = $1)::int AS staff,
              (SELECT count(*) FROM staff_activation WHERE tenant_id = $1)::int AS activation,
              (SELECT count(*) FROM seat WHERE tenant_id = $1)::int AS seats`,
      [tenantId],
    ),
  ).then((r) => r.rows[0]);

const create = (slug: string) =>
  request(control.getHttpServer())
    .post('/admin/tenants')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Failing Cinemas', slug, contactEmail: `admin@${slug}.test` })
    .expect(202)
    .then((r) => r.body.tenant_id as string);

beforeAll(async () => {
  await asAdmin(urls.adminUrl, (c) => addOperator(c, 'ops@fail.test'));
  control = await bootControlApp(urls, redisUrl, { ONBOARDING_ATTEMPTS: '1' });
  token = (await request(control.getHttpServer()).post('/admin/auth/login').send({ email: 'ops@fail.test', password: TEST_PASSWORD })).body
    .access_token;
});
afterAll(() => control?.close());

describe('onboarding failure and rollback', () => {
  it('a forced failure at step 3 rolls back every recorded resource', async () => {
    const svc = control.get(OnboardingService);
    svc.steps = [
      ONBOARDING_STEPS[0]!,
      ONBOARDING_STEPS[1]!,
      ONBOARDING_STEPS[2]!, // seed_sample_theatre: theatre, screen and 96 seats to compensate
      { name: 'activate_tenant', run: async () => Promise.reject(new Error('injected failure at step 3')) },
    ];
    try {
      const tenantId = await create(`fail-${Date.now().toString(36)}`);
      const status = await waitForStatus(control, token, tenantId, ['rolled_back', 'failed']);
      expect(status.status).toBe('rolled_back');
      expect(status.error).toMatch(/injected failure/);
      expect(status.steps.map((s: { status: string }) => s.status)).toEqual(['compensated', 'compensated', 'compensated']);
      expect(await countsFor(tenantId)).toEqual({ tenant: 0, staff: 0, activation: 0, seats: 0 });
    } finally {
      svc.steps = ONBOARDING_STEPS;
    }
  });
});
