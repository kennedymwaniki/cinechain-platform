import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { TenantDb } from './tenant-db.provider';

/**
 * Reporting's OWN pool, on the same cinechain_app role (so RLS applies exactly
 * as for booking), but separate and small. Reporting and booking have
 * different reliability needs: a slow chain-wide report may wait or fail; it
 * must never take the connections a hold or a sale needs.
 *
 * It fails FAST when exhausted (connectionTimeoutMillis) instead of queueing
 * requests without bound. Handlers using it must be @DeferTenantTransaction,
 * or the request would already hold a booking-pool connection.
 */
export class ReportingDb extends TenantDb {}

export const REPORTING_DB_PROVIDER = {
  provide: ReportingDb,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) =>
    new ReportingDb({ url: cfg.db.url, max: cfg.db.reportingPoolMax, applicationName: 'cinechain-reporting', connectionTimeoutMillis: 2_000 }),
};
