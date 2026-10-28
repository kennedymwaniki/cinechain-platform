import { count, sql } from 'drizzle-orm';
import { defer, from, lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tenantCustomer } from '../db/schema/app';
import { addCustomers, asAdmin, createTenant, type SeededTenant } from '../../test/support/seed';
import { currentTenant, db, runWithTenant, type TenantContext } from './tenant-context';
import { TenantDb } from './tenant-db.provider';
import { SecurityEvents } from '../audit/security-event.service';
import { IdentityDb } from './identity-db.provider';
import { TenantInterceptor } from './tenant.interceptor';
import { TenantRegistry } from './tenant-registry.service';

const urls = inject('db');
const system = { kind: 'system', reason: 'test' } as const;
const ctxFor = (t: SeededTenant): TenantContext => ({ tenantId: t.id, actor: system });
const countCustomers = async () => (await db().select({ n: count() }).from(tenantCustomer))[0]!.n;

let A: SeededTenant;
let B: SeededTenant;

beforeAll(async () => {
  await asAdmin(urls.adminUrl, async (c) => {
    A = await createTenant(c);
    B = await createTenant(c);
    await addCustomers(c, A.id, 2);
    await addCustomers(c, B.id, 1);
  });
});

describe('connection hygiene', () => {
  const tdb = new TenantDb({ url: urls.appUrl, max: 1 }); // ONE connection: every request reuses it
  afterAll(() => tdb.onApplicationShutdown());

  it('does not leak app.tenant_id across pooled requests', async () => {
    await runWithTenant(ctxFor(A), () => tdb.withTenantScope(async () => expect(await countCustomers()).toBe(2)));
    await runWithTenant(ctxFor(B), () => tdb.withTenantScope(async () => expect(await countCustomers()).toBe(1)));

    // The assertion that actually catches the leak. Both scopes above set
    // their own tenant, so they would pass even with set_config(..., false).
    // What leaks is the NEXT, unscoped query on the same physical connection:
    // with is_local=false it would still see tenant B's row.
    const leaked = await tdb.registryQuery<{ guc: string | null; n: number }>(
      `SELECT current_setting('app.tenant_id', true) AS guc, (SELECT count(*)::int FROM tenant_customer) AS n`,
      [],
    );
    expect(leaked[0]!.n).toBe(0);
    expect(leaked[0]!.guc ?? '').toBe('');
  });

  it('fails closed: with no tenant set, a tenant table returns zero rows, not an error', async () => {
    const rows = await tdb.registryQuery<{ n: number }>('SELECT count(*)::int AS n FROM tenant_customer', []);
    expect(rows[0]!.n).toBe(0);
  });

  it('treats an empty-string tenant as "no tenant" rather than raising 22P02', async () => {
    const rows = await tdb.registryQuery<{ n: number }>(
      `SELECT set_config('app.tenant_id', '', false), (SELECT count(*)::int FROM tenant_customer) AS n`,
      [],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('rolls back the whole scope when the handler throws', async () => {
    const email = `rollback-${Date.now()}@example.test`;
    await expect(
      runWithTenant(ctxFor(A), () =>
        tdb.withTenantScope(async () => {
          await db().insert(tenantCustomer).values({ tenantId: A.id, email });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    const n = await runWithTenant(ctxFor(A), () =>
      tdb.withTenantScope(async () => (await db().execute(sql`SELECT count(*)::int AS n FROM tenant_customer WHERE email = ${email}`)).rows[0]),
    );
    expect(n).toEqual({ n: 0 });
  });

  it('nests as a savepoint: an inner failure does not abort the outer scope', async () => {
    await runWithTenant(ctxFor(A), () =>
      tdb.withTenantScope(async () => {
        await expect(
          tdb.withTenantScope(async () => {
            await db().execute(sql`SELECT 1/0`);
          }),
        ).rejects.toThrow();
        expect(await countCustomers()).toBe(2); // outer transaction still usable
      }),
    );
  });

  it('WITH CHECK rejects writing a row stamped with another tenant', async () => {
    await expect(
      runWithTenant(ctxFor(A), () =>
        tdb.withTenantScope(() => db().insert(tenantCustomer).values({ tenantId: B.id, email: 'x@example.test' })),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('context guards', () => {
  const tdb = new TenantDb({ url: urls.appUrl, max: 2 });
  afterAll(() => tdb.onApplicationShutdown());

  it('currentTenant() outside a scope throws — it never returns a default', () => {
    expect(() => currentTenant()).toThrow(/No tenant context/);
  });

  it('db() outside a DB scope throws', async () => {
    await runWithTenant(ctxFor(A), async () => expect(() => db()).toThrow(/No tenant DB scope/));
  });

  it('refuses a nested scope for a different tenant', async () => {
    await expect(
      runWithTenant(ctxFor(A), () =>
        tdb.withTenantScope(() => runWithTenant(ctxFor(B), () => tdb.withTenantScope(async () => 1))),
      ),
    ).rejects.toThrow(/different tenant/);
  });

  it('refuses to query when context and DB scope diverge', async () => {
    await expect(
      runWithTenant(ctxFor(A), () => tdb.withTenantScope(() => runWithTenant(ctxFor(B), async () => db()))),
    ).rejects.toThrow(/divergence/);
  });

  it('rejects a tenant id that is not a uuid', async () => {
    await expect(
      runWithTenant({ tenantId: "x'; DROP TABLE tenant; --", actor: system }, () => tdb.withTenantScope(async () => 1)),
    ).rejects.toThrow(/not a uuid/);
  });
});

describe('boot assertion', () => {
  it('accepts cinechain_app', async () => {
    const tdb = new TenantDb({ url: urls.appUrl, max: 1 });
    await expect(tdb.assertSafeRole()).resolves.toBeUndefined();
    await tdb.onApplicationShutdown();
  });

  it('refuses a superuser / owner connection', async () => {
    const tdb = new TenantDb({ url: urls.adminUrl, max: 1 });
    await expect(tdb.assertSafeRole()).rejects.toThrow(/Refusing to start.*superuser/);
    await tdb.onApplicationShutdown();
  });

  it('refuses the identity role, which can read platform.*', async () => {
    const tdb = new TenantDb({ url: urls.identityUrl, max: 1 });
    await expect(tdb.assertSafeRole()).rejects.toThrow(/platform schema/);
    await tdb.onApplicationShutdown();
  });
});

describe('TenantInterceptor (PRD correction 2)', () => {
  const tdb = new TenantDb({ url: urls.appUrl, max: 1 });
  const identity = new IdentityDb(urls.identityUrl, 1);
  afterAll(async () => {
    await tdb.onApplicationShutdown();
    await identity.onApplicationShutdown();
  });
  const interceptor = new TenantInterceptor(tdb, new TenantRegistry(tdb), new SecurityEvents(identity), new Reflector());

  const httpContext = (req: object): ExecutionContext =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    }) as unknown as ExecutionContext;

  // Like Nest's CallHandler: a COLD observable — the handler runs on subscribe.
  const handlerThat = (fn: () => Promise<unknown>): CallHandler => ({ handle: () => defer(() => from(fn())) });

  it('runs the handler INSIDE the open transaction, then commits', async () => {
    let seen: number | undefined;
    const out = interceptor.intercept(
      httpContext({ tenantContext: ctxFor(A) }),
      handlerThat(async () => {
        seen = await countCustomers();
        return { ok: true };
      }),
    );
    await expect(lastValueFrom(out)).resolves.toEqual({ ok: true });
    expect(seen).toBe(2);
  });

  it('leaves unscoped requests unscoped', async () => {
    const out = interceptor.intercept(
      httpContext({}),
      handlerThat(async () => {
        expect(() => currentTenant()).toThrow();
        return 'public';
      }),
    );
    await expect(lastValueFrom(out)).resolves.toBe('public');
  });
});
