import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
const login = async (app: INestApplication) =>
  (await request(app.getHttpServer()).post('/admin/auth/login').send({ email: 'ops@resume.test', password: TEST_PASSWORD })).body
    .access_token as string;

beforeAll(async () => {
  await asAdmin(urls.adminUrl, (c) => addOperator(c, 'ops@resume.test'));
  control = await bootControlApp(urls, redisUrl, { ONBOARDING_ATTEMPTS: '3' });
  token = await login(control);
});
afterAll(() => control?.close());

describe('onboarding resumes', () => {
  it('a crash after step 1 committed resumes at step 2 — step 1 is never redone', async () => {
    const svc = control.get(OnboardingService);
    let createTenantRuns = 0;
    let crashes = 0;
    svc.steps = [
      { name: 'create_tenant', run: async (ctx) => (createTenantRuns++, ONBOARDING_STEPS[0]!.run(ctx)) },
      {
        name: 'create_chain_admin',
        run: async (ctx) => {
          if (crashes++ === 0) throw new Error('worker killed mid-step'); // its transaction rolls back
          return ONBOARDING_STEPS[1]!.run(ctx);
        },
      },
      ...ONBOARDING_STEPS.slice(2),
    ];
    try {
      const slug = `resume-${Date.now().toString(36)}`;
      const res = await request(control.getHttpServer())
        .post('/admin/tenants')
        .set('authorization', `Bearer ${token}`)
        .send({ name: 'Resume Cinemas', slug, contactEmail: `admin@${slug}.test` })
        .expect(202);
      const final = await waitForStatus(control, token, res.body.tenant_id, ['active', 'rolled_back', 'failed']);
      expect(final.status).toBe('active');
      expect(crashes).toBe(2); // crashed once, succeeded on the retry
      expect(createTenantRuns).toBe(1); // resumed, not restarted from zero
    } finally {
      svc.steps = ONBOARDING_STEPS;
    }
  });

  it('a run whose job was lost (process killed) is picked up when the control plane restarts', async () => {
    const tenantId = randomUUID();
    const slug = `orphan-${Date.now().toString(36)}`;
    await asAdmin(urls.adminUrl, (c) =>
      c.query(
        `INSERT INTO platform.onboarding_run (tenant_id, slug, request, status, requested_by)
         VALUES ($1, $2, $3, 'provisioning', gen_random_uuid())`,
        [tenantId, slug, { name: 'Orphan', slug, tier: 'basic', country: 'KE', contactEmail: `admin@${slug}.test` }],
      ),
    );
    const restarted = await bootControlApp(urls, redisUrl, { ONBOARDING_ATTEMPTS: '3' });
    try {
      const final = await waitForStatus(restarted, await login(restarted), tenantId, ['active', 'rolled_back', 'failed']);
      expect(final.status).toBe('active');
    } finally {
      await restarted.close();
    }
  });
});
