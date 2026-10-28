/**
 * GENERATED cross-tenant probe suite. Every route Nest knows about is read
 * from its own metadata. Each non-@Public route must either have a probe here
 * (called with tenant B's ids under a tenant-A token, expecting 404) or be in
 * NO_RESOURCE_IDS with a reason. A new route that is in neither list fails;
 * a listed route that no longer exists fails too.
 */
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CONSUMER_ROUTE, IS_PUBLIC } from '../../src/auth/decorators';
import { setupSwagger } from '../../src/common/swagger';
import { asAdmin, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';
import { seedVenueTenant, type VenueTenant } from './helpers/seed-venue-tenant';

type BTenant = VenueTenant & { filmId: string; ruleId: string; screeningId: string };
type Probe = { params: (b: BTenant) => Record<string, string>; body?: (b: BTenant) => object };

/** "METHOD /path" → how to aim it at tenant B. */
const PROBES: Record<string, Probe> = {
  'GET /staff/:id': { params: (b) => ({ id: b.clerkId }) },
  'PUT /staff/:id/theatres': { params: (b) => ({ id: b.clerkId }), body: () => ({ theatre_ids: [] }) },
  'POST /staff/:id/suspend': { params: (b) => ({ id: b.clerkId }) },
  'POST /staff/:id/reactivate': { params: (b) => ({ id: b.clerkId }) },
  'DELETE /staff/:id': { params: (b) => ({ id: b.clerkId }) },
  'GET /theatres/:id': { params: (b) => ({ id: b.theatreId }) },
  'PATCH /theatres/:id': { params: (b) => ({ id: b.theatreId }), body: () => ({ name: 'Hijacked' }) },
  'GET /screens/:id': { params: (b) => ({ id: b.screenId }) },
  'PATCH /screens/:id': { params: (b) => ({ id: b.screenId }), body: () => ({ turnaround_minutes: 240 }) },
  'POST /screens/:id/seats:generate': { params: (b) => ({ id: b.screenId }), body: () => ({ rows: 1, seatsPerRow: 1 }) },
  'POST /screens/:id/out-of-service': { params: (b) => ({ id: b.screenId }), body: () => ({ reason: 'hijacked' }) },
  'POST /screens/:id/restore': { params: (b) => ({ id: b.screenId }) },
  'PATCH /seats/:id': { params: (b) => ({ id: b.seatId }), body: () => ({ is_active: false }) },
  'GET /films/:id': { params: (b) => ({ id: b.filmId }) },
  'PATCH /films/:id': { params: (b) => ({ id: b.filmId }), body: () => ({ title: 'Hijacked' }) },
  'POST /films/:id/poster': { params: (b) => ({ id: b.filmId }) },
  'GET /screenings/:id': { params: (b) => ({ id: b.screeningId }) },
  'POST /screenings/:id/publish': { params: (b) => ({ id: b.screeningId }) },
  'POST /screenings/:id/close': { params: (b) => ({ id: b.screeningId }) },
  'POST /screenings/:id/complete': { params: (b) => ({ id: b.screeningId }) },
  'POST /screenings/:id/cancel': { params: (b) => ({ id: b.screeningId }) },
  'POST /screenings': {
    params: () => ({}),
    body: (b) => ({ screen_id: b.screenId, film_id: b.filmId, starts_at: new Date(Date.now() + 864e5).toISOString() }),
  },
  'POST /screenings:copy': {
    params: () => ({}),
    body: (b) => ({ theatre_id: b.theatreId, from_date: '2026-11-01', to_date: '2026-11-08', span: 'week' }),
  },
  // ids in the BODY are probed too
  'POST /screens': { params: () => ({}), body: (b) => ({ theatre_id: b.theatreId, name: 'Probe' }) },
};

/** Staff routes that take no resource id at all, so there is nothing to aim at tenant B. */
const NO_RESOURCE_IDS: Record<string, string> = {
  'GET /auth/staff/me': 'returns the caller’s own verified claims',
  'GET /staff': 'list: asserted below to contain none of tenant B’s ids',
  'POST /staff/invitations': 'creates in the caller’s tenant; theatre_ids probed in venues.spec',
  'GET /theatres': 'list: asserted below to contain none of tenant B’s ids',
  'POST /theatres': 'creates in the caller’s tenant',
  'GET /films': 'list: asserted below to contain none of tenant B’s ids',
  'POST /films': 'creates in the caller’s tenant',
  'GET /pricing-rules': 'list: asserted below to contain none of tenant B’s ids',
  'POST /pricing-rules': 'creates in the caller’s tenant; currency is the caller’s, set server-side',
  'GET /screenings': 'list: asserted below to contain none of tenant B’s ids (theatre_id filter probed in scheduling.spec)',
};

const LISTS = ['GET /staff', 'GET /theatres', 'GET /films', 'GET /pricing-rules', 'GET /screenings'];

/** Controllers deliberately absent from the probe app. Each must be @Public. */
const NOT_MOUNTED: Record<string, string> = {
  HealthController: '@Public; needs live Redis and MinIO, which this suite does not start',
};

const urls = inject('db');
let app: INestApplication;
let A: VenueTenant;
let B: BTenant;
let tokenA: string;
let routes: { key: string; guarded: boolean }[];

function discoverRoutes(application: INestApplication) {
  const out: { key: string; guarded: boolean; controller: string }[] = [];
  for (const mod of application.get(ModulesContainer).values())
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!ctrl) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (method === undefined || path === undefined) continue;
        const full = `/${[base, path].filter((p) => p && p !== '/').join('/')}`.replace(/\/+/g, '/').replace(/\\:/g, ':');
        const isPublic = Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, ctrl);
        const isConsumer = Reflect.getMetadata(CONSUMER_ROUTE, handler) ?? Reflect.getMetadata(CONSUMER_ROUTE, ctrl);
        out.push({ key: `${RequestMethod[method]} ${full}`, guarded: !isPublic && !isConsumer, controller: ctrl.name });
      }
    }
  return out;
}

beforeAll(async () => {
  A = await seedVenueTenant(urls.adminUrl, 'route-a');
  const b = await seedVenueTenant(urls.adminUrl, 'route-b');
  B = await asAdmin(urls.adminUrl, async (c) => {
    const filmId = (await c.query(`INSERT INTO film (tenant_id, title, runtime_min) VALUES ($1, 'B Film', 120) RETURNING id`, [b.id])).rows[0].id;
    const screeningId = (
      await c.query(
        `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format)
         VALUES ($1, $2, $3, now() + interval '2 days', now() + interval '2 days 2 hours', 60, 'standard') RETURNING id`,
        [b.id, b.screenId, filmId],
      )
    ).rows[0].id;
    return {
    ...b,
    filmId,
    screeningId,
    ruleId: (
      await c.query(
        `INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from) VALUES ($1, 'standard', 1, 'KES', now()) RETURNING id`,
        [b.id],
      )
    ).rows[0].id,
    };
  });
  app = await bootTestApp(urls);
  tokenA = (
    await request(app.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: A.adminEmail, password: TEST_PASSWORD, tenant_slug: A.slug })
  ).body.access_token;
  routes = discoverRoutes(app);
});
afterAll(() => app.close());

describe('generated route table', () => {
  it('every application controller in src/ is mounted in the test app', () => {
    const SRC = join(__dirname, '../../src');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const declared = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !f.includes('/control/'))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/@Controller\([^)]*\)\s*export class (\w+)/g)].map((m) => m[1]!));
    const mounted = new Set(discoverRoutes(app).map((r) => r.controller));
    expect(declared.filter((c) => !mounted.has(c) && !(c in NOT_MOUNTED))).toEqual([]);
  });

  it('the OpenAPI document builds for every mounted route (a bad DTO crashes boot)', () => {
    expect(() => setupSwagger(app)).not.toThrow();
  });

  it('every non-public route is either probed or explicitly has no resource ids', () => {
    const guarded = routes.filter((r) => r.guarded).map((r) => r.key).sort();
    const accounted = [...Object.keys(PROBES), ...Object.keys(NO_RESOURCE_IDS)].sort();
    expect(guarded).toEqual(accounted);
  });

  it("every probe with tenant B's ids under a tenant-A token returns 404", async () => {
    const failures: string[] = [];
    for (const [key, probe] of Object.entries(PROBES)) {
      const [method, path] = key.split(' ') as [string, string];
      const params = probe.params(B);
      const url = `/api/v1${path.replace(/:(\w+)/g, (m, p: string) => params[p] ?? m)}`;
      const verb = method.toLowerCase() as 'get';
      const res = await request(app.getHttpServer())[verb](url)
        .set('authorization', `Bearer ${tokenA}`)
        .send(probe.body?.(B) ?? {});
      if (res.status !== 404) failures.push(`${key} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
    }
    expect(failures).toEqual([]);
  });

  it("list endpoints contain none of tenant B's ids", async () => {
    const bIds = [B.id, B.adminId, B.clerkId, B.theatreId, B.otherTheatreId, B.screenId, B.otherScreenId, B.seatId, B.filmId, B.ruleId, B.screeningId];
    for (const key of LISTS) {
      const res = await request(app.getHttpServer()).get(`/api/v1${key.split(' ')[1]}`).set('authorization', `Bearer ${tokenA}`);
      expect(res.status, key).toBe(200);
      for (const id of bIds) expect(res.text, `${key} leaks ${id}`).not.toContain(id);
    }
  });

  it("the probes changed nothing in tenant B", async () => {
    const { rows } = await asAdmin(urls.adminUrl, (c) =>
      c.query(
        `SELECT (SELECT name FROM theatre WHERE id = $2) AS theatre,
                (SELECT status FROM screen WHERE id = $3) AS screen,
                (SELECT is_active FROM seat WHERE id = $4) AS seat,
                (SELECT status FROM staff_user WHERE id = $5) AS clerk,
                (SELECT count(*)::int FROM seat WHERE screen_id = $3) AS seats,
                (SELECT count(*)::int FROM screen WHERE tenant_id = $1) AS screens,
                (SELECT title FROM film WHERE id = $6) AS film,
                (SELECT status::text FROM screening WHERE id = $7) AS screening,
                (SELECT count(*)::int FROM screening WHERE tenant_id = $1) AS screenings`,
        [B.id, B.theatreId, B.screenId, B.seatId, B.clerkId, B.filmId, B.screeningId],
      ),
    );
    expect(rows[0]).toEqual({ theatre: 'Westlands', screen: 'active', seat: true, clerk: 'active', seats: 4, screens: 2, film: 'B Film', screening: 'draft', screenings: 1 });
  });
});
