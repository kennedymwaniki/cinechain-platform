import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditLog } from '../audit/audit-log.service';
import { PricingService } from '../catalogue/pricing.service';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors/api-error';
import type { ScreenFormat, SeatClass } from '../db/schema/venue';
import { Metrics } from '../metrics/metrics.service';
import { RedisHealthBreaker } from '../redis/redis-health.breaker';
import { type Money, sum, toWire } from '../shared/money';
import { Doors } from '../tenancy/doors';
import { toSystemContext } from '../tenancy/system-context';
import { type Actor, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { HoldRepository } from './hold.repository';
import { InventoryEvents } from './inventory-events';
import { HoldTokenService } from './hold-token.service';
import { RedisLocks } from './redis-locks';
import { checkSeatGap } from './seat-gap.policy';
import { internalState } from './seat-state.mapper';
import { SeatmapService } from './seatmap.service';

export const MIN_HOLD_SECONDS = 120;
export const MAX_HOLD_SECONDS = 900;
export const EXTENSION_SECONDS = 120;

export const clampHoldSeconds = (s: number) => Math.min(MAX_HOLD_SECONDS, Math.max(MIN_HOLD_SECONDS, s));

export interface PlaceHold {
  ctx: TenantContext; // tenant resolved server-side: from the resource, or a staff JWT
  screeningId: string;
  seatIds: readonly string[];
  ttlSeconds: number;
  channel: 'online' | 'box_office';
  heldByStaff: string | null;
  /** Box office only (FR-47): skip the seat-gap rule; audited. */
  gapOverrideReason?: string | null;
}

const seatsUnavailable = (ids: readonly string[]) =>
  conflict('seats_unavailable', 'Some of these seats are no longer available', { unavailable_seat_ids: [...ids].sort() });

/**
 * Holds: all-or-nothing, at most one holder per seat, released by TTL with no
 * job on the critical path. Redis (one Lua script) answers the common case
 * fast; the Postgres primary key is the actual guarantee, and on its own is a
 * complete hold path when Redis is down.
 */
@Injectable()
export class HoldService {
  constructor(
    private readonly doors: Doors,
    private readonly registry: TenantRegistry,
    private readonly tenantDb: TenantDb,
    private readonly seatmaps: SeatmapService,
    private readonly pricing: PricingService,
    private readonly repo: HoldRepository,
    private readonly locks: RedisLocks,
    private readonly breaker: RedisHealthBreaker,
    private readonly tokens: HoldTokenService,
    private readonly metrics: Metrics,
    private readonly audit: AuditLog,
    private readonly events: InventoryEvents,
  ) {}

  /** A guest or consumer: the tenant comes from the screening, through the sanctioned door. */
  async placeOnline(screeningId: string, seatIds: readonly string[], actor: Actor) {
    const owner = await this.doors.resolvePublishedScreening(screeningId);
    if (!owner) throw notFound();
    const tenant = await this.registry.byId(owner.tenantId);
    if (!tenant) throw notFound();
    return this.place({
      ctx: toSystemContext(owner, actor),
      screeningId,
      seatIds,
      ttlSeconds: clampHoldSeconds(tenant.holdSeconds),
      channel: 'online',
      heldByStaff: null,
    });
  }

  async place(req: PlaceHold) {
    const { ctx, screeningId, seatIds } = req;
    const tenant = await this.registry.byId(ctx.tenantId);
    if (!tenant) throw notFound();
    if (new Set(seatIds).size !== seatIds.length) throw badRequest('duplicate_seats', 'Each seat may appear only once');
    if (seatIds.length > tenant.maxSeatsPerBooking)
      throw unprocessable('too_many_seats', `At most ${tenant.maxSeatsPerBooking} seats per booking`, {
        max_seats: tenant.maxSeatsPerBooking,
      });

    // The seat map as it was a moment ago (≤ 5 s). Good enough for the
    // ADVISORY gap rule; the one-holder guarantee never relies on it.
    const snap = await this.seatmaps.snapshotFor(ctx.tenantId, screeningId, ctx.actor);
    const byId = new Map(snap.seats.map((s) => [s.id, s]));
    const unknown = seatIds.filter((id) => !byId.has(id));
    if (unknown.length) throw unprocessable('unknown_seats', 'These seats are not in this screening', { unknown_seat_ids: unknown });

    if (!req.gapOverrideReason) {
      const now = Date.now();
      const taken = new Set(snap.seats.filter((s) => internalState(snap.locks[s.id], null, now) !== 'AVAILABLE').map((s) => s.id));
      const verdict = checkSeatGap(
        snap.seats.map((s) => ({ id: s.id, row: s.y, col: s.x, seatClass: s.seat_class })),
        taken,
        seatIds,
        (Date.parse(snap.screening.starts_at) - now) / 60_000,
        { policy: tenant.seatGapPolicy, occupancyThreshold: tenant.seatGapOccupancyThreshold, liftMinutes: tenant.seatGapLiftMinutes },
      );
      if (!verdict.ok)
        throw conflict('seat_gap', 'This choice would leave a single empty seat between taken seats', {
          gap_seat_ids: verdict.gapSeatIds,
          suggested_seat_ids: verdict.suggestion,
        });
    }

    // Priced server-side, now. The quote travels in the signed token.
    const format = snap.screening.format as ScreenFormat;
    const prices = await runWithTenant(ctx, () =>
      this.tenantDb.withTenantScope(async () => {
        const out = new Map<string, Money>();
        for (const cls of new Set(seatIds.map((id) => byId.get(id)!.seat_class))) {
          const p = await this.pricing.priceFor(cls as SeatClass, format, new Date());
          if (!p) throw unprocessable('price_unavailable', `No price is set for ${cls} seats`);
          out.set(cls, p);
        }
        return out;
      }),
    );

    const holdId = randomUUID();
    const ref = { tenantId: ctx.tenantId, screeningId, holdId, seatIds };

    // 1. Redis fast path: ONE atomic script. Skipped entirely while the breaker is open.
    const fast = await this.breaker.attempt(() =>
      this.locks.acquire(ref, req.ttlSeconds * 1000, { seat_ids: seatIds, channel: req.channel }),
    );
    if (fast.ok && !fast.value.ok) throw seatsUnavailable(fast.value.conflictSeatIds);
    const redisTook = fast.ok;

    // 2. The durable row: the actual guarantee.
    let rows: { seatId: string; expiresAt: Date }[];
    try {
      rows = await runWithTenant(ctx, () =>
        this.tenantDb.withTenantScope(async () => {
          const inserted = await this.repo.insertHeld({
            screeningId,
            tenantId: ctx.tenantId,
            holdId,
            ttlSeconds: req.ttlSeconds,
            seatIds,
            heldByStaff: req.heldByStaff,
          });
          if (inserted.length !== seatIds.length) {
            // Correction 4: never trust a partial insert. Throwing rolls it back.
            const got = new Set(inserted.map((r) => r.seatId));
            const lost = seatIds.filter((id) => !got.has(id));
            const blockers = await this.repo.blockers(screeningId, lost);
            if (redisTook && blockers.some((b) => b.status === 'held'))
              this.metrics.inc('hold.redis_postgres_divergence', { tenant: ctx.tenantId });
            throw seatsUnavailable(lost);
          }
          if (req.gapOverrideReason)
            await this.audit.record('hold.seat_gap_override', 'hold', holdId, { reason: req.gapOverrideReason, seat_ids: seatIds });
          return inserted;
        }),
      );
    } catch (e) {
      // Surrender what Redis gave us, whatever went wrong after it.
      if (redisTook) await this.breaker.attempt(() => this.locks.release(ref));
      throw e;
    }
    this.metrics.inc('hold.placed', { tenant: ctx.tenantId, path: redisTook ? 'redis' : 'postgres' });
    await this.seatmaps.invalidate(ctx.tenantId, screeningId);

    const expiresAt = rows.reduce((min, r) => (r.expiresAt < min ? r.expiresAt : min), rows[0]!.expiresAt);
    // The seat-map version: bumped inside the Lua script on the fast path; bumped here on the Postgres-only path.
    const version = fast.ok && fast.value.ok ? fast.value.version : await this.bumpVersion(ctx.tenantId, screeningId);
    await this.events.emit({ kind: 'hold.placed', tenantId: ctx.tenantId, screeningId, holdId, seatIds: [...seatIds], expiresAt, version });
    const priced = seatIds.map((id) => {
      const s = byId.get(id)!;
      return { seat: s, price: prices.get(s.seat_class)! };
    });
    const total = sum(
      priced.map((p) => p.price),
      priced[0]!.price.currency,
    );
    const holdToken = await this.tokens.sign(
      {
        hold_id: holdId,
        screening_id: screeningId,
        tenant_id: ctx.tenantId,
        seat_ids: [...seatIds],
        quoted_total_minor: total.amountMinor,
        currency: total.currency,
        channel: req.channel,
      },
      expiresAt,
    );
    return {
      hold_id: holdId,
      hold_token: holdToken,
      expires_at: expiresAt.toISOString(),
      screening_id: screeningId,
      seats: priced.map(({ seat, price }) => ({
        id: seat.id,
        row: seat.row,
        number: seat.number,
        seat_class: seat.seat_class,
        price: toWire(price),
      })),
      total: toWire(total),
    };
  }

  /** The seat-map version outside a Lua script; null if Redis is unavailable (clients then refetch). */
  private async bumpVersion(tenantId: string, screeningId: string): Promise<number | null> {
    const r = await this.breaker.attempt(() => this.locks.bumpVersion(tenantId, screeningId));
    return r.ok ? r.value : null;
  }

  /** FR-46. Possession of the token is the claim; the tenant is the one the server signed into it. */
  async release(holdId: string, token: string | undefined, actor: Actor): Promise<void> {
    const c = await this.tokens.verify(token, { holdId });
    const ctx = toSystemContext({ tenantId: c.tenant_id }, actor);
    const freed = await runWithTenant(ctx, () => this.tenantDb.withTenantScope(() => this.repo.release(holdId)));
    const r = await this.breaker.attempt(() =>
      this.locks.release({ tenantId: c.tenant_id, screeningId: c.screening_id, holdId, seatIds: c.seat_ids }),
    );
    await this.seatmaps.invalidate(c.tenant_id, c.screening_id);
    if (freed.length) {
      const version = r.ok && r.value.released > 0 ? r.value.version : await this.bumpVersion(c.tenant_id, c.screening_id);
      await this.events.emit({ kind: 'hold.released', tenantId: c.tenant_id, screeningId: c.screening_id, holdId, seatIds: freed, version });
    }
  }

  /** FR-45: once, by 120 s, and only if nobody has tried for these seats meanwhile. */
  async extend(holdId: string, token: string | undefined, actor: Actor) {
    const c = await this.tokens.verify(token, { holdId });
    const ref = { tenantId: c.tenant_id, screeningId: c.screening_id, holdId, seatIds: c.seat_ids };
    const contested = await this.breaker.attempt(() => this.locks.isContested(ref));
    if (contested.ok && contested.value)
      throw conflict('hold_contested', 'Someone else is waiting for these seats, so this hold cannot be extended');

    const ctx = toSystemContext({ tenantId: c.tenant_id }, actor);
    const { expiresAt, now } = await runWithTenant(ctx, () =>
      this.tenantDb.withTenantScope(async () => {
        const rows = await this.repo.extend(holdId, EXTENSION_SECONDS);
        // All or nothing: a partly-live hold is not extended (throwing rolls back).
        if (rows.length !== c.seat_ids.length)
          throw conflict('hold_not_extendable', 'This hold has expired or has already been extended');
        return { expiresAt: rows[0]!.expiresAt, now: await this.repo.now() };
      }),
    );
    await this.breaker.attempt(() => this.locks.extend(ref, expiresAt.getTime() - now.getTime()));
    await this.events.emit({ kind: 'hold.extended', tenantId: c.tenant_id, screeningId: c.screening_id, holdId, seatIds: c.seat_ids, expiresAt });
    const { typ: _typ, ...claims } = c;
    return {
      hold_id: holdId,
      hold_token: await this.tokens.sign(claims, expiresAt),
      expires_at: expiresAt.toISOString(),
    };
  }
}
