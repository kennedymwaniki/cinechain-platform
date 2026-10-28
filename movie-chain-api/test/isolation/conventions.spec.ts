import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { FixturesModule, handlerCalls } from '../support/fixtures.module';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD, type SeededTenant } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
let A: SeededTenant;
let B: SeededTenant;
let tokenA: string;
const http = () => request(app.getHttpServer());
const mismatches = async () =>
  (await asAdmin(urls.adminUrl, (c) => c.query(`SELECT count(*)::int AS n FROM platform.security_event WHERE kind = 'tenant_mismatch'`)))
    .rows[0].n as number;

beforeAll(async () => {
  [A, B] = await asAdmin(urls.adminUrl, async (c) => {
    const a = await createTenant(c);
    const b = await createTenant(c);
    await addStaff(c, a.id, 'admin@conv-a.test');
    await c.query(`INSERT INTO tenant_customer (tenant_id, email) VALUES ($1, 'only-in-b@example.test')`, [b.id]);
    return [a, b];
  });
  app = await bootTestApp(urls, { modules: [FixturesModule] });
  tokenA = (await http().post('/api/v1/auth/staff/login').send({ email: 'admin@conv-a.test', password: TEST_PASSWORD, tenant_slug: A.slug }))
    .body.access_token;
});
afterAll(() => app.close());

describe('idempotency', () => {
  it('a replayed Idempotency-Key returns the identical body and status without re-running the handler', async () => {
    const body = { email: 'idem@example.test', display_name: 'Idem' };
    const send = () => http().post('/api/v1/fixtures/customers').set('authorization', `Bearer ${tokenA}`).set('idempotency-key', 'k1').send(body);
    const before = handlerCalls.create;
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(handlerCalls.create - before).toBe(1);
    const n = await asAdmin(urls.adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM tenant_customer WHERE email = 'idem@example.test'`),
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('the same key with a different request is a 422', async () => {
    const res = await http()
      .post('/api/v1/fixtures/customers')
      .set('authorization', `Bearer ${tokenA}`)
      .set('idempotency-key', 'k1')
      .send({ email: 'other@example.test', display_name: 'Other' });
    expect([res.status, res.body.error]).toEqual([422, 'idempotency_key_reused']);
  });

  it('concurrent duplicates execute once', async () => {
    const before = handlerCalls.create;
    const body = { email: 'race@example.test', display_name: 'Race' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http().post('/api/v1/fixtures/customers').set('authorization', `Bearer ${tokenA}`).set('idempotency-key', 'race').send(body),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(handlerCalls.create - before).toBe(1);
  });

  it('a missing key is a 400', async () => {
    const res = await http().post('/api/v1/fixtures/customers').set('authorization', `Bearer ${tokenA}`).send({ email: 'x@example.test', display_name: 'X' });
    expect([res.status, res.body.error]).toEqual([400, 'idempotency_key_required']);
  });
});

describe('validation and errors', () => {
  it('.strict() rejects an unexpected tenant_id field', async () => {
    const res = await http()
      .post('/api/v1/fixtures/customers')
      .set('authorization', `Bearer ${tokenA}`)
      .set('idempotency-key', 'strict-1')
      .send({ email: 'strict@example.test', display_name: 'S', tenant_id: B.id });
    expect([res.status, res.body.error]).toEqual([400, 'validation_failed']);
    expect(JSON.stringify(res.body.issues)).toContain('unrecognized_keys');
  });

  it('a cross-tenant read is a 404 byte-identical to a missing resource', async () => {
    const other = await http().get('/api/v1/fixtures/customers/only-in-b@example.test').set('authorization', `Bearer ${tokenA}`);
    const missing = await http().get('/api/v1/fixtures/customers/nobody@example.test').set('authorization', `Bearer ${tokenA}`);
    expect(other.status).toBe(404);
    expect(other.text).toBe(missing.text);
  });

  it('a cross-tenant WRITE (a bug) is stopped by RLS, answered 404, and recorded as tenant_mismatch', async () => {
    const before = await mismatches();
    const res = await http().post(`/api/v1/fixtures/customers/buggy-write/${B.id}`).set('authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Resource not found' });
    expect((await mismatches()) - before).toBe(1);
    const planted = await asAdmin(urls.adminUrl, (c) => c.query(`SELECT count(*)::int AS n FROM tenant_customer WHERE email = 'planted@example.test'`));
    expect(planted.rows[0].n).toBe(0);
  });

  it('an unknown route has the same 404 body', async () => {
    const res = await http().get('/api/v1/no/such/route').set('authorization', `Bearer ${tokenA}`);
    expect([res.status, res.body]).toEqual([404, { error: 'not_found', message: 'Resource not found' }]);
  });

  it('an unexpected error is a 500 that leaks nothing', async () => {
    const res = await http().get('/api/v1/fixtures/customers/boom/now').set('authorization', `Bearer ${tokenA}`);
    expect([res.status, res.body]).toEqual([500, { error: 'internal_error', message: 'Something went wrong' }]);
    expect(res.text).not.toContain('postgres://');
  });

  it('the audit row commits with the change it records', async () => {
    const n = await asAdmin(urls.adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'customer.created'`, [A.id]),
    );
    expect(n.rows[0].n).toBe(2); // idem@ and race@ — not the replays, not the rejected ones
  });
});
