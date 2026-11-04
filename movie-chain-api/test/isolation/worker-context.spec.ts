/**
 * Convention 10, enforced by running the code. Every @Processor in the DI
 * container is found and called with NOTHING but a job payload — no ambient
 * tenant context. Each must open a database scope for exactly the payload's
 * tenant, or be one of the reviewed exceptions:
 *   @CrossTenantJob  — the elevated jobs (ELEVATED_JOBS.md);
 *   @RegistryFanout  — a tick that reads only the tenant registry; its
 *                      per-tenant job is probed like any other.
 * A new processor with no probe here fails the suite.
 */
import type { INestApplication } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModulesContainer } from '@nestjs/core';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { GuestLinkModule } from '../../src/booking/guest-link.module';
import { ReconciliationModule } from '../../src/booking/reconciliation.module';
import { CROSS_TENANT_JOB, REGISTRY_FANOUT } from '../../src/common/elevated/cross-tenant-job';
import { SweeperModule } from '../../src/inventory/sweeper.module';
import { NotificationModule } from '../../src/notification/notification.module';
import { QueueModule } from '../../src/queue/queue.module';
import { RealtimeModule } from '../../src/realtime/realtime.module';
import { ExportModule } from '../../src/reporting/export.module';
import { LifecycleModule } from '../../src/lifecycle/lifecycle.module';
import { maybeCurrentTenant } from '../../src/tenancy/tenant-context';
import { TenantDb } from '../../src/tenancy/tenant-db.provider';
import { asAdmin, createTenant } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const PROCESSOR_METADATA = 'bullmq:processor_metadata';

/** Class name → a job that names a tenant (and whatever else the processor reads). */
const PROBES: Record<string, (tenantId: string) => { name: string; data: Record<string, unknown> }> = {
  LinkGuestProcessor: (tenantId) => ({ name: 'link', data: { tenantId, consumerId: crypto.randomUUID(), email: 'nobody@probe.test' } }),
  NotificationProcessor: (tenantId) => ({ name: 'booking.confirmed', data: { tenantId, kind: 'booking.confirmed', bookingId: crypto.randomUUID() } }),
  HoldTimerProcessor: (tenantId) => ({
    name: 'expired',
    data: { tenantId, screeningId: crypto.randomUUID(), holdId: crypto.randomUUID(), seatIds: [], expiresAt: new Date().toISOString(), kind: 'expired' },
  }),
  LifecycleProcessor: (tenantId) => ({ name: 'counts', data: { tenantId, action: 'counts' } }),
  ExportProcessor: (tenantId) => ({ name: 'export', data: { tenantId, exportId: crypto.randomUUID() } }),
  // The registry fan-out's real work: one tenant's reconciliation.
  ReconciliationProcessor: (tenantId) => ({ name: 'reconcile', data: { tenantId } }),
};

const urls = inject('db');
let redis: StartedTestContainer;
let app: INestApplication;
let tenantId: string;

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).withWaitStrategy(Wait.forLogMessage('Ready to accept connections')).start();
  app = await bootTestApp(urls, {
    modules: [QueueModule, RealtimeModule, NotificationModule, GuestLinkModule, ReconciliationModule, SweeperModule, ExportModule, LifecycleModule],
    env: { REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`, SWEEPER_DATABASE_URL: urls.sweeperUrl },
  });
  tenantId = await asAdmin(urls.adminUrl, async (c) => (await createTenant(c)).id);
}, 180_000);
afterAll(async () => {
  await app.close();
  await redis.stop();
});

type Ctor = abstract new (...args: never[]) => unknown;

function processors() {
  const out: { name: string; instance: { process: (job: unknown) => Promise<unknown> }; meta: Ctor }[] = [];
  for (const mod of app.get(ModulesContainer).values())
    for (const w of mod.providers.values()) {
      const ctor = w.metatype as Ctor | null;
      if (ctor && w.instance && Reflect.getMetadata(PROCESSOR_METADATA, ctor))
        out.push({ name: ctor.name, instance: w.instance as never, meta: ctor });
    }
  return out;
}

describe('worker context', () => {
  it('every processor is either probed here or a reviewed exception', () => {
    const found = processors();
    expect(found.length).toBeGreaterThanOrEqual(5);
    const unaccounted = found.filter((p) => !(p.name in PROBES) && !Reflect.getMetadata(CROSS_TENANT_JOB, p.meta)).map((p) => p.name);
    expect(unaccounted).toEqual([]);
    for (const name of Object.keys(PROBES)) expect(found.map((p) => p.name), `${name} no longer exists`).toContain(name);
    for (const p of found.filter((x) => Reflect.getMetadata(REGISTRY_FANOUT, x.meta))) expect(PROBES, `${p.name}: its per-tenant job must be probed`).toHaveProperty(p.name);
  });

  it('no processor relies on ambient context: each opens a scope for exactly the tenant in its payload', async () => {
    const scopes: { processor: string; tenant: string | undefined }[] = [];
    // Only scopes opened BY the probed call count: real background jobs (the reconciler's
    // scheduled fan-out, say) open scopes for other tenants at the same time.
    const probing = new AsyncLocalStorage<string>();
    const original = TenantDb.prototype.withTenantScope;
    const spy = vi.spyOn(TenantDb.prototype, 'withTenantScope').mockImplementation(function <T>(this: TenantDb, fn: () => Promise<T>) {
      const processor = probing.getStore();
      if (processor) scopes.push({ processor, tenant: maybeCurrentTenant()?.tenantId });
      return original.call(this, fn) as Promise<T>;
    });
    try {
      for (const p of processors()) {
        const probe = PROBES[p.name];
        if (!probe) continue; // a reviewed @CrossTenantJob
        expect(maybeCurrentTenant(), 'the test itself must hold no context').toBeUndefined();
        await probing.run(p.name, () => p.instance.process({ ...probe(tenantId), id: 'probe', attemptsMade: 0, opts: {} })).catch(() => undefined); // payload data may not exist; the scope is what matters
        const mine = scopes.filter((s) => s.processor === p.name);
        expect(mine.length, `${p.name} opened no tenant scope`).toBeGreaterThan(0);
        for (const s of mine) expect(s.tenant, `${p.name} opened a scope for the wrong tenant`).toBe(tenantId);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
