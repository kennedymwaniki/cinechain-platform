import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asAdmin } from '../../test/support/seed';
import { bootTestApp } from '../../test/support/test-app';
import { ConsumerService } from './consumer.service';
import { LogVerificationMailer } from './verification-mailer';

const urls = inject('db');
let app: INestApplication;
let svc: ConsumerService;
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());

beforeAll(async () => {
  app = await bootTestApp(urls, {
    env: {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/v1/auth/google/callback',
    },
  });
  svc = app.get(ConsumerService);
});
afterAll(() => app.close());

describe('Google sign-in', () => {
  it('redirects to Google with a signed state bound to an HttpOnly cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/google').expect(302);
    const loc = new URL(res.headers.location!);
    expect(loc.hostname).toBe('accounts.google.com');
    const state = loc.searchParams.get('state')!;
    expect(state.split('.')).toHaveLength(3);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/cc_oauth_state=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain(state.split('.')[0]);
  });

  it('a callback with a forged state is rejected before reaching Google', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/google/callback?code=x&state=a.1.b');
    expect(res.status).toBe(401);
  });

  it('refuses an e-mail Google did not verify', async () => {
    await expect(
      svc.googleSignIn({ subject: 'g-unverified', email: 'u@g.test', emailVerified: false, displayName: null }),
    ).rejects.toMatchObject({ code: 'email_not_verified' });
  });

  it('creates a verified consumer with no tenant claim', async () => {
    const s = await svc.googleSignIn({ subject: 'g-new', email: 'new@g.test', emailVerified: true, displayName: 'New' });
    expect(s.consumer.email_verified).toBe(true);
    expect(Object.keys(claims(s.access_token))).not.toContain('tenant_id');
    // the same Google subject signs into the same account
    const again = await svc.googleSignIn({ subject: 'g-new', email: 'new@g.test', emailVerified: true, displayName: 'New' });
    expect(claims(again.access_token).sub).toBe(claims(s.access_token).sub);
  });

  it('links to an existing VERIFIED password account and keeps its password', async () => {
    const mailer = app.get(LogVerificationMailer);
    await svc.register('owner@g.test', 'owner-password-1', null);
    await svc.verifyEmail(new URL(mailer.outbox.get('owner@g.test')!).searchParams.get('token')!);
    const g = await svc.googleSignIn({ subject: 'g-owner', email: 'owner@g.test', emailVerified: true, displayName: null });
    const pw = await svc.login('owner@g.test', 'owner-password-1');
    expect(claims(g.access_token).sub).toBe(claims(pw.access_token).sub);
  });

  it('pre-registration takeover: linking to an UNVERIFIED account clears the unproven password and its sessions', async () => {
    // An attacker registers the victim's address first, with a password they know…
    await svc.register('victim@g.test', 'attacker-knows-this', null);
    const attacker = await svc.login('victim@g.test', 'attacker-knows-this');
    // …then the real owner signs in with Google.
    await svc.googleSignIn({ subject: 'g-victim', email: 'victim@g.test', emailVerified: true, displayName: 'Victim' });

    await expect(svc.login('victim@g.test', 'attacker-knows-this')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(svc.rotate(attacker.refresh_token)).rejects.toMatchObject({ code: 'refresh_token_invalid' });
    const row = await asAdmin(urls.adminUrl, (c) =>
      c.query(`SELECT email_verified, password_hash FROM platform.consumer WHERE email = 'victim@g.test'`),
    );
    expect(row.rows[0]).toEqual({ email_verified: true, password_hash: null });
  });
});
