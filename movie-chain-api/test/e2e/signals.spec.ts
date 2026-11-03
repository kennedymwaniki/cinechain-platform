/** Step 23: every signal answers "which tenant?" — traces, metrics and logs — with no call-site effort. */
import type { INestApplication } from '@nestjs/common';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PinoLogger } from '../../src/observability/logger';
import { initTracing, shutdownTracing } from '../../src/observability/tracing';
import { postHold, seedSellable } from '../support/holds';
import { addStaff, asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
const spans = new InMemorySpanExporter();
let app: INestApplication;
const logLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  initTracing({ service: 'cinechain-test', otlpUrl: null, extraProcessors: [new SimpleSpanProcessor({ exporter: spans })] });
  // Redis unreachable on purpose: the breaker's warnings are request-time log lines to inspect.
  app = await bootTestApp(urls, { env: { REDIS_URL: 'redis://127.0.0.1:1' } });
  app.useLogger(
    new PinoLogger({
      level: 'debug',
      destination: new Writable({
        write(chunk, _e, cb) {
          for (const l of String(chunk).split('\n').filter(Boolean)) logLines.push(JSON.parse(l));
          cb();
        },
      }),
    }),
  );
});
afterAll(async () => {
  await app.close();
  await shutdownTracing();
});

const roots = () => spans.getFinishedSpans().filter((s) => !s.parentSpanContext);
/** The root span ends on the response's `finish`, which can land just after the client has the body. */
async function rootFor(route: string) {
  for (let i = 0; i < 50; i++) {
    const r = roots().find((s) => s.attributes['http.route'] === route);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  return undefined;
}

describe('tenant-attributed signals', () => {
  it('the root span of a staff request carries tenant.id from the token', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    const slug = (await asAdmin(urls.adminUrl, (c) => c.query(`SELECT slug FROM tenant WHERE id = $1`, [t.tenantId]))).rows[0].slug;
    await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `sig@${slug}.test`, 'chain_admin'));
    const tok = (await request(app.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: `sig@${slug}.test`, password: TEST_PASSWORD, tenant_slug: slug })).body.access_token;
    spans.reset();
    await request(app.getHttpServer()).get('/api/v1/theatres').set('authorization', `Bearer ${tok}`).expect(200);
    const root = await rootFor('/api/v1/theatres');
    expect(root?.attributes['tenant.id']).toBe(t.tenantId);
  });

  it("a guest's root span carries the tenant of the screening they named — and so does every log line of that request", async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    spans.reset();
    logLines.length = 0;
    const res = await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201);
    const root = await rootFor('/api/v1/screenings/:id/holds');
    expect(root?.attributes['tenant.id']).toBe(t.tenantId);
    const requestId = res.headers['x-request-id'];
    const mine = logLines.filter((l) => l.request_id === requestId);
    expect(mine.length).toBeGreaterThan(0); // the breaker's "redis call failed" warnings
    for (const l of mine) expect(l.tenant_id).toBe(t.tenantId);
  });

  it('the scrape exposes tenant-labelled series, from loopback', async () => {
    const t = await seedSellable(urls.adminUrl, 2);
    await postHold(app, t.screeningId, [t.seatIds[0]!]).expect(201);
    const text = (await request(app.getHttpServer()).get('/api/v1/metrics').expect(200)).text;
    expect(text).toMatch(new RegExp(`cinechain_hold_acquire_seconds_bucket\\{[^}]*tenant="${t.tenantId}"`));
    expect(text).toMatch(new RegExp(`cinechain_http_request_duration_seconds_count\\{[^}]*tenant="${t.tenantId}"`));
    expect(text).toMatch(/cinechain_double_sale_total\{tenant="none"\} 0/);
    expect(text).toMatch(/^cinechain_redis_up \d/m);
    for (const line of text.split('\n').filter((l) => /^cinechain_hold_acquire_seconds/.test(l))) expect(line).toContain('tenant=');
  });
});
