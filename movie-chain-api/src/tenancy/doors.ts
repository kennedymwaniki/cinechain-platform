import { Injectable } from '@nestjs/common';
import { TenantDb, UUID_RE } from './tenant-db.provider';

export interface ShowtimeRow {
  tenant_id: string;
  chain_slug: string;
  chain_name: string;
  theatre_id: string;
  theatre_name: string;
  city: string;
  timezone: string;
  screen_id: string;
  film_id: string;
  title: string;
  runtime_min: number;
  rating: string | null;
  language: string | null;
  poster_key: string | null;
  screening_id: string;
  starts_at: Date;
  format: string;
}

export interface ShowtimeFilter {
  city?: string | undefined;
  from: Date;
  to: Date;
  filmId?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
  rating?: string | undefined;
  format?: string | undefined;
}

/**
 * The ONLY application entry points to the sanctioned cross-tenant read doors
 * (SECURITY DEFINER functions owned by cinechain_resolver). They run with no
 * tenant set — that is the point — and return the tenant as DATA, which the
 * caller then turns into a scope with toSystemContext(). The tenant id never
 * comes from the caller: only from these lookups.
 */
@Injectable()
export class Doors {
  constructor(private readonly tenantDb: TenantDb) {}

  /** Published screening of an active chain → its tenant. Anything else → null. */
  async resolvePublishedScreening(screeningId: string): Promise<{ tenantId: string } | null> {
    if (!UUID_RE.test(screeningId)) return null;
    const rows = await this.tenantDb.registryQuery<{ tenant_id: string }>(
      'SELECT tenant_id FROM resolve_published_screening($1::uuid)',
      [screeningId],
    );
    return rows[0] ? { tenantId: rows[0].tenant_id } : null;
  }

  /** Published showtimes across every chain: poster data only, no demand signals. */
  publicShowtimes(f: ShowtimeFilter): Promise<ShowtimeRow[]> {
    return this.tenantDb.registryQuery<ShowtimeRow>(
      'SELECT * FROM public_showtimes($1, $2, $3, $4::uuid, $5, $6, $7, $8)',
      [f.city ?? null, f.from, f.to, f.filmId ?? null, f.title ?? null, f.language ?? null, f.rating ?? null, f.format ?? null],
    );
  }
}
