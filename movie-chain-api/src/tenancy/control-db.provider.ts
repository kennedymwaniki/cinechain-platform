import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import * as schema from '../db/schema/index';
import { TenantDb } from './tenant-db.provider';

export type ControlDrizzle = NodePgDatabase<typeof schema>;

/**
 * The control plane's database handle, on the cinechain_control role. It
 * inherits withTenantScope (onboarding writes a new tenant's first staff
 * user INSIDE that tenant's scope, so RLS still applies), and adds
 * transactions on platform.* control tables with no tenant set.
 */
export class ControlDb extends TenantDb {
  async platformTx<T>(fn: (tx: ControlDrizzle) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const out = await fn(drizzle({ client, schema }));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
  }

  /**
   * The control role must not be a superuser, must not bypass RLS, must own
   * nothing, and must not reach application data or the consumer directory.
   */
  async assertSafeControlRole(): Promise<void> {
    const rows = await this.registryQuery<{ problem: string }>(
      `SELECT problem FROM (
         SELECT 'is a superuser' AS problem FROM pg_roles WHERE rolname = current_user AND rolsuper
         UNION ALL SELECT 'has BYPASSRLS' FROM pg_roles WHERE rolname = current_user AND rolbypassrls
         UNION ALL SELECT 'owns relations' WHERE EXISTS (
           SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = current_user)
         UNION ALL SELECT 'can read platform.consumer'
           WHERE has_table_privilege(current_user, 'platform.consumer', 'SELECT')
         UNION ALL SELECT 'can read ' || t FROM unnest(ARRAY['booking','ticket','payment']) AS t
           WHERE to_regclass('public.' || t) IS NOT NULL AND has_table_privilege(current_user, 'public.' || t, 'SELECT')
       ) p`,
      [],
    );
    if (rows.length)
      throw new Error(`Refusing to start the control plane: database role ${rows.map((r) => r.problem).join(', ')}.`);
  }
}

export const CONTROL_DB_PROVIDER = {
  provide: ControlDb,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => {
    if (!cfg.db.controlUrl) throw new Error('CONTROL_DATABASE_URL is required for the control plane');
    return new ControlDb({ url: cfg.db.controlUrl, max: 5, applicationName: 'cinechain-control' });
  },
};
