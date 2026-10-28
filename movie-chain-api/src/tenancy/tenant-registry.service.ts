import { Injectable } from '@nestjs/common';
import { TenantDb, UUID_RE } from './tenant-db.provider';

export type TenantStatus = 'pending' | 'provisioning' | 'active' | 'suspended' | 'offboarding';

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  tier: 'basic' | 'standard' | 'premium' | 'dedicated';
  status: TenantStatus;
  holdSeconds: number;
  maxSeatsPerBooking: number;
  currency: string;
  turnaroundMinutes: number;
}

const TTL_MS = 15_000; // a suspension takes effect within this window
const MAX_ENTRIES = 10_000;

interface Entry {
  value: TenantRecord | null;
  at: number;
}

/**
 * Cached lookup of the tenant registry by id and by slug. Fails closed: a
 * lookup error propagates (the request fails); it never falls back to a stale
 * or default tenant. "Not found" is cached briefly too, so probing random ids
 * does not hammer the database.
 */
@Injectable()
export class TenantRegistry {
  private readonly byIdCache = new Map<string, Entry>();
  private readonly bySlugCache = new Map<string, Entry>();

  constructor(private readonly tenantDb: TenantDb) {}

  async byId(id: string): Promise<TenantRecord | null> {
    if (!UUID_RE.test(id)) return null;
    return this.cached(this.byIdCache, id.toLowerCase(), 'id = $1::uuid');
  }

  async bySlug(slug: string): Promise<TenantRecord | null> {
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return null;
    return this.cached(this.bySlugCache, slug, 'slug = $1');
  }

  /** Drop cached entries, e.g. after the control plane changes a tenant. */
  invalidate(): void {
    this.byIdCache.clear();
    this.bySlugCache.clear();
  }

  private async cached(cache: Map<string, Entry>, key: string, where: string): Promise<TenantRecord | null> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    const rows = await this.tenantDb.registryQuery<TenantRecord>(
      `SELECT id, slug, name, tier, status,
              hold_seconds AS "holdSeconds", max_seats_per_booking AS "maxSeatsPerBooking", currency, turnaround_minutes AS "turnaroundMinutes"
         FROM tenant WHERE ${where}`,
      [key],
    );
    const value = rows[0] ?? null;
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { value, at: Date.now() });
    return value;
  }
}
