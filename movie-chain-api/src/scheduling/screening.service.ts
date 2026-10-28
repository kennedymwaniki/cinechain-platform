import { Injectable } from '@nestjs/common';
import { AuditLog } from '../audit/audit-log.service';
import { CatalogueRepository } from '../catalogue/catalogue.repository';
import { badRequest, conflict, notFound } from '../common/errors/api-error';
import type { Screening, ScreeningStatus } from '../db/schema/screening';
import { currentTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { TheatreScope } from '../venue/theatre-scope.service';
import { VenueRepository } from '../venue/venue.repository';
import { canTransition } from './screening.state-machine';
import { ScreeningRepository } from './screening.repository';

const DAY_MS = 86_400_000;
const MIN_TURNAROUND = 60;

export const screeningView = (s: Screening, extra: Record<string, unknown> = {}) => ({
  id: s.id,
  screen_id: s.screenId,
  film_id: s.filmId,
  starts_at: s.startsAt,
  ends_at: s.endsAt,
  turnaround_minutes: s.turnaroundMinutes,
  blocked_until: s.blockedUntil,
  format: s.format,
  status: s.status,
  ...extra,
});

@Injectable()
export class ScreeningService {
  constructor(
    private readonly repo: ScreeningRepository,
    private readonly venues: VenueRepository,
    private readonly catalogue: CatalogueRepository,
    private readonly scope: TheatreScope,
    private readonly registry: TenantRegistry,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditLog,
  ) {}

  /**
   * There is deliberately NO "is the screen free?" pre-check: two managers
   * would both pass it. The exclusion constraint is the mechanism; a
   * violation surfaces as 409 screening_overlap.
   */
  async create(v: { screenId: string; filmId: string; startsAt: Date; turnaroundMinutes: number | null }) {
    const screen = await this.venues.findScreen(v.screenId);
    if (!screen) throw notFound();
    await this.scope.assert(screen.theatreId);
    const film = await this.catalogue.findFilm(v.filmId);
    if (!film) throw notFound();
    if (screen.status !== 'active') throw conflict('screen_out_of_service', 'This screen is out of service');
    if (v.startsAt.getTime() <= Date.now()) throw badRequest('starts_in_past', 'A screening must start in the future');

    const tenant = await this.registry.byId(currentTenant().tenantId);
    const s = await this.repo.insert({
      screenId: screen.id,
      filmId: film.id,
      startsAt: v.startsAt,
      endsAt: new Date(v.startsAt.getTime() + film.runtimeMin * 60_000),
      // this screening's own value → the screen's default → the chain's default
      turnaroundMinutes: v.turnaroundMinutes ?? screen.turnaroundMinutes ?? tenant!.turnaroundMinutes,
      format: screen.format,
    });
    await this.audit.record('screening.created', 'screening', s.id, { screen_id: screen.id, film_id: film.id });
    return screeningView(s, { film_title: film.title, theatre_id: screen.theatreId });
  }

  async get(id: string) {
    const r = await this.load(id);
    return screeningView(r.screening, { film_title: r.filmTitle, theatre_id: r.theatreId });
  }

  async list(f: { theatreId?: string | undefined; from?: Date | undefined; to?: Date | undefined }) {
    const s = await this.scope.current();
    if (f.theatreId) {
      if (!(await this.venues.findTheatre(f.theatreId))) throw notFound();
      await this.scope.assert(f.theatreId);
    }
    const from = f.from ?? new Date();
    const to = f.to ?? new Date(from.getTime() + 14 * DAY_MS);
    const theatreIds = f.theatreId ? [f.theatreId] : s.all ? null : [...s.ids];
    const rows = await this.repo.list({ theatreIds, from, to });
    return rows.map((r) => screeningView(r.screening, { film_title: r.filmTitle, theatre_id: r.theatreId, screen_name: r.screenName }));
  }

  async transition(id: string, to: ScreeningStatus) {
    const r = await this.load(id);
    const from = r.screening.status;
    if (!canTransition(from, to)) throw conflict('invalid_transition', `A ${from} screening cannot become ${to}`);
    if (to === 'published') {
      if (r.screenStatus !== 'active') throw conflict('screen_out_of_service', 'This screen is out of service');
      if (r.screening.startsAt.getTime() <= Date.now()) throw conflict('starts_in_past', 'Cannot publish a screening that has started');
      if ((await this.repo.activeSeatCount(r.screening.screenId)) === 0)
        throw conflict('no_seats', 'The screen has no seat layout yet');
    }
    // Conditional on the status we read: a concurrent transition makes this a no-op → 409.
    const s = await this.repo.transition(id, from, to);
    if (!s) throw conflict('invalid_transition', 'The screening changed state; reload and retry');
    await this.audit.record(`screening.${to}`, 'screening', id, { from });
    return screeningView(s);
  }

  /**
   * FR-24: copy a day or week forward, as DRAFTS. Each copy is inserted in
   * its own savepoint, so one collision is reported and skipped rather than
   * aborting the whole copy.
   */
  async copy(v: { theatreId: string; fromDate: string; toDate: string; span: 'day' | 'week' }) {
    if (!(await this.venues.findTheatre(v.theatreId))) throw notFound();
    await this.scope.assert(v.theatreId);
    const spanDays = v.span === 'week' ? 7 : 1;
    const shiftDays = Math.round((Date.parse(v.toDate) - Date.parse(v.fromDate)) / DAY_MS);
    if (shiftDays < spanDays) throw badRequest('invalid_range', `to_date must be at least ${spanDays} day(s) after from_date`);

    const sources = await this.repo.sourcesForCopy(v.theatreId, v.fromDate, spanDays, shiftDays);
    const created: string[] = [];
    const skipped: { source_id: string; reason: string }[] = [];
    for (const src of sources) {
      if (src.newStartsAt.getTime() <= Date.now()) {
        skipped.push({ source_id: src.sourceId, reason: 'starts_in_past' });
        continue;
      }
      try {
        const s = await this.tenantDb.withTenantScope(() =>
          this.repo.insert({
            screenId: src.screenId,
            filmId: src.filmId,
            startsAt: src.newStartsAt,
            endsAt: new Date(src.newStartsAt.getTime() + src.durationMs),
            // a copy keeps the source's cleaning time, raised to the floor if it predates it
            turnaroundMinutes: Math.max(src.turnaroundMinutes, MIN_TURNAROUND),
            format: src.format,
          }),
        );
        created.push(s.id);
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
        if (code !== '23P01') throw e;
        skipped.push({ source_id: src.sourceId, reason: 'screening_overlap' });
      }
    }
    await this.audit.record('schedule.copied', 'theatre', v.theatreId, { ...v, created: created.length, skipped: skipped.length });
    return { created: created.length, created_ids: created, skipped };
  }

  private async load(id: string) {
    const r = await this.repo.find(id);
    if (!r) throw notFound();
    await this.scope.assert(r.theatreId);
    return r;
  }
}
