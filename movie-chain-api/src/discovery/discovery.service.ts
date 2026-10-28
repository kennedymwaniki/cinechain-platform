import { Injectable } from '@nestjs/common';
import { notFound } from '../common/errors/api-error';
import { StorageService } from '../storage/storage.service';
import { Doors, type ShowtimeFilter, type ShowtimeRow } from '../tenancy/doors';
import { runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { toSystemContext } from '../tenancy/system-context';
import { DiscoveryRepository } from './discovery.repository';

const POSTER_TTL_S = 300;

/**
 * Public, cross-chain browsing (FR-30, FR-31, FR-34). Reads go through the
 * public_showtimes door, which returns poster data only. Never returned:
 * tenant ids, seat counts, or anything about holds and sales — sold-out is a
 * single boolean.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly doors: Doors,
    private readonly repo: DiscoveryRepository,
    private readonly tenantDb: TenantDb,
    private readonly storage: StorageService,
  ) {}

  async films(f: ShowtimeFilter) {
    const rows = await this.doors.publicShowtimes(f);
    const byFilm = new Map<string, ShowtimeRow[]>();
    for (const r of rows) byFilm.set(r.film_id, [...(byFilm.get(r.film_id) ?? []), r]);
    return Promise.all(
      [...byFilm.values()].map(async (group) => {
        const first = group[0]!;
        return {
          film: await this.film(first),
          chain: { slug: first.chain_slug, name: first.chain_name },
          theatres: [...new Set(group.map((g) => g.theatre_name))].sort(),
          next_showtime: first.starts_at,
          showtimes: group.length,
        };
      }),
    );
  }

  /** All showtimes for one film, grouped by theatre, with sold-out marks (FR-31). */
  async screenings(filmId: string, f: Omit<ShowtimeFilter, 'filmId'>) {
    const rows = await this.doors.publicShowtimes({ ...f, filmId });
    if (!rows.length) throw notFound();
    // The film belongs to exactly one chain: its tenant comes from the resource.
    const tenantId = rows[0]!.tenant_id;
    const soldOut = await runWithTenant(toSystemContext({ tenantId }, { kind: 'guest' }), () =>
      this.tenantDb.withTenantScope(() => this.repo.soldOut(rows.map((r) => r.screening_id))),
    );
    const theatres = new Map<string, { theatre: object; screenings: object[] }>();
    for (const r of rows) {
      const t = theatres.get(r.theatre_id) ?? {
        theatre: { id: r.theatre_id, name: r.theatre_name, city: r.city, timezone: r.timezone },
        screenings: [],
      };
      t.screenings.push({ id: r.screening_id, starts_at: r.starts_at, format: r.format, sold_out: soldOut.has(r.screening_id) });
      theatres.set(r.theatre_id, t);
    }
    return { film: await this.film(rows[0]!), chain: { slug: rows[0]!.chain_slug, name: rows[0]!.chain_name }, theatres: [...theatres.values()] };
  }

  private async film(r: ShowtimeRow) {
    return {
      id: r.film_id,
      title: r.title,
      runtime_min: r.runtime_min,
      rating: r.rating,
      language: r.language,
      poster_url: r.poster_key ? await this.storage.getSignedUrlForKey(r.poster_key, POSTER_TTL_S) : null,
    };
  }
}
