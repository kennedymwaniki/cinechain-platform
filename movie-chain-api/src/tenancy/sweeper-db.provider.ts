import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { poolConfig } from './tenant-db.provider';

export interface SweptRow {
  tenant_id: string;
  screening_id: string;
  seat_id: string;
  expires_at: Date;
}

/**
 * The sweeper's connection, as cinechain_sweeper. Deliberately NOT a general
 * handle: it exposes one statement. The role bypasses RLS (it must see every
 * tenant's expired holds at once), so its reach is limited by GRANT — and
 * this class refuses to start if that GRANT has grown.
 */
export class SweeperDb implements OnApplicationShutdown {
  private readonly log = new Logger(SweeperDb.name);
  private readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool(poolConfig({ url, max: 2, applicationName: 'cinechain-sweeper' }));
    this.pool.on('error', (e) => this.log.warn(`idle client error: ${e.message}`));
  }

  /**
   * Deletes holds expired for longer than the grace period. The grace
   * guarantees the durable row outlives its Redis key, so a hold that is
   * mid-conversion is never deleted; SKIP LOCKED guarantees a conversion
   * holding the row is never even blocked.
   */
  async sweepExpiredHolds(graceSeconds: number, limit: number): Promise<SweptRow[]> {
    const { rows } = await this.pool.query<SweptRow>(
      `WITH victims AS (
         SELECT screening_id, seat_id FROM seat_lock
          WHERE status = 'held' AND expires_at < now() - $1::int * interval '1 second'
          ORDER BY expires_at LIMIT $2
          FOR UPDATE SKIP LOCKED)
       DELETE FROM seat_lock s USING victims v
        WHERE s.screening_id = v.screening_id AND s.seat_id = v.seat_id
       RETURNING s.tenant_id, s.screening_id, s.seat_id, s.expires_at`,
      [graceSeconds, limit],
    );
    return rows;
  }

  /** The role may touch seat_lock and nothing else in public, and nothing in platform. */
  async assertNarrowRole(): Promise<void> {
    const { rows } = await this.pool.query<{ problem: string }>(
      `SELECT 'can read ' || c.relname AS problem
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'platform') AND c.relkind IN ('r', 'p', 'v')
          AND c.relname <> 'seat_lock'
          AND (has_table_privilege(current_user, c.oid, 'SELECT')
               OR has_any_column_privilege(current_user, c.oid, 'SELECT'))
       UNION ALL
       SELECT 'is a superuser' FROM pg_roles WHERE rolname = current_user AND rolsuper`,
    );
    if (rows.length) throw new Error(`Refusing to start the sweeper: database role ${rows.map((r) => r.problem).join(', ')}.`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export const SWEEPER_DB_PROVIDER = {
  provide: SweeperDb,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => (cfg.db.sweeperUrl ? new SweeperDb(cfg.db.sweeperUrl) : null),
};
