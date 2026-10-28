import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import * as appSchema from '../db/schema/app';
import { currentTenant, internal, type DbScope } from './tenant-context';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantDbOptions {
  url: string;
  max: number;
  applicationName?: string;
}

export function poolConfig(o: TenantDbOptions): PoolConfig {
  return {
    connectionString: o.url,
    max: o.max,
    statement_timeout: 5000,
    // Kills a leaked scope that is holding a transaction open.
    idle_in_transaction_session_timeout: 10000,
    application_name: o.applicationName ?? 'cinechain-api',
  };
}

/**
 * Acquires ONE client, BEGINs, sets app.tenant_id transaction-locally, binds
 * Drizzle to that client, runs, COMMITs, releases. Re-entrancy becomes a
 * SAVEPOINT on the same client — never a nested BEGIN, never a second client.
 *
 * Constructed by TENANT_DB_PROVIDER (a factory), so tests can build one with
 * their own URL and pool size.
 */
export class TenantDb implements OnApplicationShutdown {
  private readonly log = new Logger(TenantDb.name);
  private readonly pool: Pool;

  constructor(options: TenantDbOptions) {
    this.pool = new Pool(poolConfig(options));
    this.pool.on('error', (e) => this.log.warn(`idle client error: ${e.message}`));
  }

  async withTenantScope<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = currentTenant();
    const existing = internal.dbAls.getStore();
    if (existing) {
      if (existing.tenantId !== ctx.tenantId) throw new Error('Nested scope for a different tenant — forbidden.');
      return this.withSavepoint(existing, fn);
    }
    if (!UUID_RE.test(ctx.tenantId)) throw new Error('tenantId is not a uuid');

    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      // NOT `SET LOCAL app.tenant_id = $1` — utility statements reject bind
      // parameters, and interpolating instead is a SQL-injection sink.
      // is_local = true reverts the setting at COMMIT/ROLLBACK.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
      const scope: DbScope = { tenantId: ctx.tenantId, client, db: drizzle({ client, schema: appSchema }), depth: 0 };
      const result = await internal.dbAls.run(scope, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // do not return a client in an unknown state to the pool
      }
      throw e;
    } finally {
      client.release(broken);
    }
  }

  private async withSavepoint<T>(scope: DbScope, fn: () => Promise<T>): Promise<T> {
    const name = `sp_${++scope.depth}`;
    await scope.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await scope.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (e) {
      await scope.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    } finally {
      scope.depth--;
    }
  }

  /**
   * Reads the tenant registry, which has no tenant_id and no RLS. Used by
   * TenantRegistry only; it cannot reach a tenant-scoped table because no
   * app.tenant_id is set, and RLS returns zero rows.
   */
  async registryQuery<R extends object>(sql: string, params: unknown[]): Promise<R[]> {
    const { rows } = await this.pool.query<R>(sql, params);
    return rows;
  }

  /** A raw client for subclasses (ControlDb); always released. */
  protected async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /**
   * Refuses to run as a role that would silently void every policy: a
   * superuser, a BYPASSRLS role, a table owner, or one that can see platform.*.
   */
  async assertSafeRole(): Promise<void> {
    const { rows } = await this.pool.query<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      owned: number;
      platform_usage: boolean;
    }>(`
      SELECT r.rolname AS role, r.rolsuper, r.rolbypassrls,
             (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned,
             coalesce(has_schema_privilege(r.oid, 'platform', 'USAGE'), false) AS platform_usage
        FROM pg_roles r WHERE r.rolname = current_user`);
    const r = rows[0];
    const problems: string[] = [];
    if (!r) problems.push('current role not found');
    else {
      if (r.rolsuper) problems.push('is a superuser');
      if (r.rolbypassrls) problems.push('has BYPASSRLS');
      if (r.owned > 0) problems.push(`owns ${r.owned} relation(s)`);
      if (r.platform_usage) problems.push('can read the platform schema');
    }
    if (problems.length)
      throw new Error(
        `Refusing to start: database role "${r?.role ?? '?'}" ${problems.join(', ')}. ` +
          'The application must connect as cinechain_app.',
      );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export function tenantDbFactory(cfg: AppConfig): TenantDb {
  return new TenantDb({ url: cfg.db.url, max: cfg.db.poolMax });
}

export const TENANT_DB_PROVIDER = {
  provide: TenantDb,
  inject: [APP_CONFIG],
  useFactory: tenantDbFactory,
};

