import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import * as platformSchema from '../db/schema/platform';
import { poolConfig } from './tenant-db.provider';

export type IdentityDrizzle = NodePgDatabase<typeof platformSchema>;

/**
 * The identity plane: a separate pool on the cinechain_identity role, which
 * is the only role with USAGE on platform.* and has no grant on any tenant
 * table. Consumers, refresh tokens and security events live behind it.
 * Only src/identity/, src/auth/ and src/audit/ should depend on this.
 */
export class IdentityDb implements OnApplicationShutdown {
  private readonly log = new Logger(IdentityDb.name);
  private readonly pool: Pool;
  readonly db: IdentityDrizzle;

  constructor(url: string, max = 5) {
    this.pool = new Pool(poolConfig({ url, max, applicationName: 'cinechain-identity' }));
    this.pool.on('error', (e) => this.log.warn(`idle client error: ${e.message}`));
    this.db = drizzle({ client: this.pool, schema: platformSchema });
  }

  /** A transaction on one client. */
  async transaction<T>(fn: (tx: IdentityDrizzle) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx as unknown as IdentityDrizzle));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export const IDENTITY_DB_PROVIDER = {
  provide: IdentityDb,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => new IdentityDb(cfg.db.identityUrl),
};
