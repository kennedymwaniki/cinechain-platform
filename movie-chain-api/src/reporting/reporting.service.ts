import { Injectable, Logger } from '@nestjs/common';
import { badRequest, notFound, unavailable } from '../common/errors/api-error';
import { RedisFactory } from '../redis/redis.module';
import { type Currency, money, toWire } from '../shared/money';
import { ReportingDb } from '../tenancy/reporting-db.provider';
import { currentTenant } from '../tenancy/tenant-context';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { TheatreScope } from '../venue/theatre-scope.service';
import { VenueRepository } from '../venue/venue.repository';
import { ReportingRepository } from './reporting.repository';

/** The stated staleness bound of the chain-wide rollup. */
export const ROLLUP_TTL_S = 60;
const MAX_RANGE_MS = 366 * 24 * 3600_000;

export const rollupKey = (tenantId: string, from: Date, to: Date) => `report:{t:${tenantId}}:revenue:${from.toISOString()}:${to.toISOString()}`;

/**
 * Reports run on the REPORTING pool, never the booking pool. Occupancy is
 * live; the chain-wide revenue rollup is cached for at most ROLLUP_TTL_S, and
 * every response says how fresh it is.
 */
@Injectable()
export class ReportingService {
  private readonly log = new Logger(ReportingService.name);

  constructor(
    private readonly reportingDb: ReportingDb,
    private readonly repo: ReportingRepository,
    private readonly registry: TenantRegistry,
    private readonly scope: TheatreScope,
    private readonly venues: VenueRepository,
    private readonly redis: RedisFactory,
  ) {}

  /** Runs `fn` on the reporting pool. Exhausted → 503, never a wait on booking's connections. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.reportingDb.withTenantScope(fn).catch((e: Error) => {
      if (/timeout exceeded when trying to connect/i.test(e.message)) throw unavailable('reporting_busy', 'Reports are busy; try again shortly');
      throw e;
    });
  }

  async occupancy(from: Date, to: Date, theatreId: string | undefined) {
    range(from, to);
    const rows = await this.run(async () => {
      const s = await this.scope.current();
      // Another chain's theatre (invisible under RLS) and one outside the caller's theatres: the same 404.
      if (theatreId && (!(await this.venues.findTheatre(theatreId)) || (!s.all && !s.ids.has(theatreId)))) throw notFound();
      const ids = theatreId ? [theatreId] : s.all ? null : [...s.ids];
      return this.repo.occupancy(from, to, ids);
    });
    return {
      as_of: new Date().toISOString(),
      screenings: rows.map((r) => ({
        ...r,
        starts_at: new Date(r.starts_at).toISOString(),
        available: Math.max(0, r.capacity - r.sold - r.held),
        // basis points: an integer, so no float ever leaves the API
        occupancy_bp: r.capacity ? Math.round((r.sold * 10_000) / r.capacity) : 0,
      })),
    };
  }

  async revenue(from: Date, to: Date) {
    range(from, to);
    const { tenantId } = currentTenant();
    const key = rollupKey(tenantId, from, to);
    const cached = await this.redis.app.get(key).catch(() => null);
    if (cached) return { ...(JSON.parse(cached) as object), cached: true };

    const tenant = await this.registry.byId(tenantId);
    const currency = tenant!.currency as Currency;
    const { byTheatre, refunded } = await this.run(async () => ({
      byTheatre: await this.repo.revenueByTheatre(from, to),
      refunded: await this.repo.refunded(from, to),
    }));
    const totalMinor = byTheatre.reduce((a, r) => a + r.total_minor, 0);
    const body = {
      from: from.toISOString(),
      to: to.toISOString(),
      currency,
      total_minor: totalMinor,
      total: toWire(money(totalMinor, currency)),
      refunded: toWire(money(refunded, currency)),
      bookings: byTheatre.reduce((a, r) => a + r.bookings, 0),
      tickets: byTheatre.reduce((a, r) => a + r.tickets, 0),
      theatres: byTheatre.map((r) => ({ theatre_id: r.theatre_id, theatre: r.theatre, bookings: r.bookings, tickets: r.tickets, total: toWire(money(r.total_minor, currency)) })),
      as_of: new Date().toISOString(),
      stale_after_s: ROLLUP_TTL_S,
    };
    await this.redis.app.set(key, JSON.stringify(body), 'EX', ROLLUP_TTL_S).catch((e: Error) => this.log.warn(`rollup cache write failed: ${e.message}`));
    return { ...body, cached: false };
  }
}

function range(from: Date, to: Date): void {
  if (!(to > from)) throw badRequest('invalid_range', '`to` must be after `from`');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw badRequest('invalid_range', 'A report covers at most one year');
}
