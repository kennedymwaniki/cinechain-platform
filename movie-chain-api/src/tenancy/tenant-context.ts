import { AsyncLocalStorage } from 'node:async_hooks';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type * as appSchema from '../db/schema/app';
import type { StaffRole } from '../db/schema/staff-user';

export type Actor =
  | { kind: 'staff'; userId: string; role: StaffRole }
  | { kind: 'consumer'; consumerId: string }
  | { kind: 'guest' }
  | { kind: 'system'; reason: string };

/** Who is acting, and for which tenant. Never built from caller input. */
export interface TenantContext {
  readonly tenantId: string;
  readonly actor: Actor;
}

export type TenantDrizzle = NodePgDatabase<typeof appSchema>;

export interface DbScope {
  readonly tenantId: string;
  readonly client: PoolClient;
  readonly db: TenantDrizzle;
  depth: number;
}

// TWO stores, not one. The context is cheap and safe to carry anywhere
// (workers, loggers). The DB scope holds a real, checked-out connection.
const ctxAls = new AsyncLocalStorage<TenantContext>();
const dbAls = new AsyncLocalStorage<DbScope>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return ctxAls.run(Object.freeze({ ...ctx }), fn);
}

export function currentTenant(): TenantContext {
  const ctx = ctxAls.getStore();
  if (!ctx)
    throw new Error(
      'No tenant context. Code ran outside a tenant-scoped request — ' +
        'if this is a worker, call runWithTenant() from the job payload.',
    );
  return ctx;
}

/** Non-throwing variant for code that must behave differently when unscoped (loggers). */
export function maybeCurrentTenant(): TenantContext | undefined {
  return ctxAls.getStore();
}

/** THE ONLY way application code obtains a database handle. */
export function db(): TenantDrizzle {
  const scope = dbAls.getStore();
  if (!scope) throw new Error('No tenant DB scope. Wrap in withTenantScope().');
  if (scope.tenantId !== currentTenant().tenantId)
    throw new Error('Tenant context/DB scope divergence — refusing to query.');
  return scope.db;
}

/** @internal — for TenantDb only. */
export const internal = { dbAls };
