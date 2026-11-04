import { Injectable } from '@nestjs/common';
import { TenantDb, UUID_RE } from '../tenancy/tenant-db.provider';

/** What a tenant may do, right now. Every number comes from configuration rows. */
export interface TenantLimits {
  tier: string;
  tierName: string;
  rateLimitRps: number; // the tenant's negotiated override, else the tier's
  maxTheatres: number;
  holdSecondsMin: number;
  holdSecondsMax: number;
  maxSeatsPerBooking: number; // the tenant's own setting, capped by the tier
  dataRetentionDays: number;
}

/** Changes reach every instance within this long: well inside one access-token lifetime, and no deploy. */
export const LIMITS_TTL_MS = 15_000;

/**
 * Limits are READ, never branched on (convention 6). A tier is a row in
 * `tier`; a tenant references one by code and may carry a negotiated rate
 * limit. Nothing outside src/tiering knows any tier by name — and nothing
 * here does either: this file has no tier literals, only columns.
 */
@Injectable()
export class TierConfig {
  private readonly cache = new Map<string, { limits: TenantLimits | null; at: number }>();

  constructor(private readonly tenantDb: TenantDb) {}

  async limitsFor(tenantId: string): Promise<TenantLimits | null> {
    if (!UUID_RE.test(tenantId)) return null;
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < LIMITS_TTL_MS) return hit.limits;
    const [row] = await this.tenantDb.registryQuery<TenantLimits>(
      `SELECT t.tier, tr.name AS "tierName",
              coalesce(t.rate_limit_rps, tr.rate_limit_rps) AS "rateLimitRps",
              tr.max_theatres AS "maxTheatres",
              tr.hold_seconds_min AS "holdSecondsMin", tr.hold_seconds_max AS "holdSecondsMax",
              least(t.max_seats_per_booking, tr.max_seats_per_booking) AS "maxSeatsPerBooking",
              tr.data_retention_days AS "dataRetentionDays"
         FROM tenant t JOIN tier tr ON tr.code = t.tier
        WHERE t.id = $1::uuid`,
      [tenantId],
    );
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(tenantId, { limits: row ?? null, at: Date.now() });
    return row ?? null;
  }

  /** The tenant's hold window, clamped to its tier's bounds. */
  holdSeconds(limits: TenantLimits, configured: number): number {
    return Math.min(limits.holdSecondsMax, Math.max(limits.holdSecondsMin, configured));
  }

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }
}
