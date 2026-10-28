import { Injectable, Logger } from '@nestjs/common';
import { notFound } from '../common/errors/api-error';
import { RedisFactory } from '../redis/redis.module';
import { Doors } from '../tenancy/doors';
import { type Actor, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { toSystemContext } from '../tenancy/system-context';
import { internalState, type LockSnapshot, toExternal } from './seat-state.mapper';
import { SeatmapRepository } from './seatmap.repository';

export const SEATMAP_TTL_S = 5;

/** Both tenant AND screening inside ONE hash tag (correction 3), so cluster mode keeps them together. */
export const seatmapKey = (tenantId: string, screeningId: string) => `seatmap:{t:${tenantId}:scr:${screeningId}}`;

interface Snapshot {
  screening: { id: string; starts_at: string; format: string; film_title: string; theatre_name: string; screen_name: string; timezone: string };
  seats: { id: string; row: string; number: number; x: number; y: number; seat_class: string }[];
  locks: Record<string, LockSnapshot>;
  at: string;
}

/**
 * The public seat map. The UNMASKED snapshot is cached for 5 s per screening
 * (one key shared by every viewer); the mask — including "yours" — is applied
 * per request, so the cache never holds anything viewer-specific.
 */
@Injectable()
export class SeatmapService {
  private readonly log = new Logger(SeatmapService.name);
  /** Database snapshot loads. Read by tests to prove the second read hits Redis. */
  dbLoads = 0;

  constructor(
    private readonly doors: Doors,
    private readonly tenantDb: TenantDb,
    private readonly repo: SeatmapRepository,
    private readonly redis: RedisFactory,
  ) {}

  async seatmap(screeningId: string, actor: Actor, viewerHoldId: string | null = null) {
    // The tenant comes from the RESOURCE, through the sanctioned door. A draft,
    // cancelled or unknown screening is the same 404.
    const owner = await this.doors.resolvePublishedScreening(screeningId);
    if (!owner) throw notFound();
    const snap = await this.snapshot(owner.tenantId, screeningId, actor);
    const now = Date.now();
    return {
      screening: snap.screening,
      // Taken seats keep their geometry (greyed, not omitted): people navigate by shape.
      seats: snap.seats.map((s) => ({ ...s, state: toExternal(internalState(snap.locks[s.id], viewerHoldId, now)) })),
      as_of: snap.at,
    };
  }

  private async snapshot(tenantId: string, screeningId: string, actor: Actor): Promise<Snapshot> {
    const key = seatmapKey(tenantId, screeningId);
    const cached = await this.redis.app.get(key).catch((e: Error) => {
      this.log.warn(`seatmap cache read failed, using the database: ${e.message}`);
      return null;
    });
    if (cached) return JSON.parse(cached) as Snapshot;

    this.dbLoads++;
    const snap = await runWithTenant(toSystemContext({ tenantId }, actor), () =>
      this.tenantDb.withTenantScope(async (): Promise<Snapshot> => {
        const meta = await this.repo.screeningMeta(screeningId);
        if (!meta) throw notFound();
        const [seats, locks] = await Promise.all([this.repo.activeSeats(meta.screenId), this.repo.locks(screeningId)]);
        return {
          screening: {
            id: meta.id,
            starts_at: meta.startsAt.toISOString(),
            format: meta.format,
            film_title: meta.filmTitle,
            theatre_name: meta.theatreName,
            screen_name: meta.screenName,
            timezone: meta.timezone,
          },
          seats: seats.map((s) => ({ id: s.id, row: s.row, number: s.number, x: s.x, y: s.y, seat_class: s.seatClass })),
          locks: Object.fromEntries(
            locks.map((l) => [l.seatId, { status: l.status, holdId: l.holdId, expiresAt: l.expiresAt?.toISOString() ?? null }]),
          ),
          at: new Date().toISOString(),
        };
      }),
    );
    await this.redis.app.set(key, JSON.stringify(snap), 'EX', SEATMAP_TTL_S).catch((e: Error) => {
      this.log.warn(`seatmap cache write failed: ${e.message}`);
    });
    return snap;
  }
}
