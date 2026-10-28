import { Injectable } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { AuditLog } from '../audit/audit-log.service';
import { badRequest, conflict, notFound } from '../common/errors/api-error';
import { booking, ticket } from '../db/schema/booking';
import { seatLock } from '../db/schema/inventory';
import { screening } from '../db/schema/screening';
import { SeatmapService } from '../inventory/seatmap.service';
import { ScreeningService } from '../scheduling/screening.service';
import { toSystemContext } from '../tenancy/system-context';
import { type Actor, currentTenant, db, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { BookingRepository } from './booking.repository';
import { BookingTokenService } from './booking-token.service';
import { OutboxRelay } from './outbox.relay';
import { RefundService } from './refund.service';

/**
 * Cancellations. Each commits the seat changes AND the refund intent in one
 * transaction, then asks the provider. The seat goes back on sale at commit
 * (FR-63); a refund that fails at the provider stays pending for the reconciler.
 */
@Injectable()
export class CancellationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly tokens: BookingTokenService,
    private readonly repo: BookingRepository,
    private readonly refunds: RefundService,
    private readonly screenings: ScreeningService,
    private readonly seatmaps: SeatmapService,
    private readonly outbox: OutboxRelay,
    private readonly audit: AuditLog,
  ) {}

  /**
   * FR-62–64: the customer cancels some or all seats, within the chain's
   * window (default 2 h before the start). Partial refunds are the tickets'
   * own captured prices. Repeating a cancellation refunds nothing twice.
   */
  async cancelBooking(bookingId: string, token: string | undefined, seatIds: string[] | undefined, actor: Actor) {
    const claims = await this.tokens.verify(token, bookingId);
    const ctx = toSystemContext({ tenantId: claims.tenant_id }, actor);
    const tenant = await this.registry.byId(ctx.tenantId);
    if (!tenant) throw notFound();

    const plan = await this.scope(ctx, async () => {
      const b = await this.repo.byId(bookingId);
      if (!b) throw notFound();
      if (b.status !== 'confirmed' && b.status !== 'cancelled') throw conflict('not_cancellable', `A ${b.status} booking cannot be cancelled`);
      const [show] = await db().select({ startsAt: screening.startsAt }).from(screening).where(eq(screening.id, b.screeningId));
      if (show!.startsAt.getTime() - Date.now() < tenant.cancellationWindowMinutes * 60_000)
        throw conflict('cancellation_window_closed', `Bookings can be cancelled up to ${tenant.cancellationWindowMinutes} minutes before the start`, {
          window_minutes: tenant.cancellationWindowMinutes,
        });

      const live = await db().select().from(ticket).where(and(eq(ticket.bookingId, b.id), ne(ticket.status, 'void')));
      const wanted = seatIds ?? live.map((t) => t.seatId);
      const unknown = wanted.filter((s) => !b.seatIds.includes(s));
      if (unknown.length) throw badRequest('unknown_seats', 'These seats are not in this booking', { unknown_seat_ids: unknown });
      if (live.some((t) => wanted.includes(t.seatId) && t.status === 'redeemed'))
        throw conflict('already_admitted', 'A ticket that has been scanned cannot be cancelled');
      const cancelling = live.filter((t) => wanted.includes(t.seatId));
      if (!cancelling.length) return { b, refundId: null, outboxIds: [] as number[], seats: [] as string[] }; // already done: idempotent

      const seats = cancelling.map((t) => t.seatId).sort();
      await this.voidSeats(b.id, b.screeningId, seats);
      const remaining = live.length - cancelling.length;
      if (remaining === 0) await this.repo.setStatus(b.id, 'confirmed', 'cancelled');
      const amountMinor = cancelling.reduce((a, t) => a + t.priceMinor, 0);
      const intent = await this.refunds.recordIntent(b.id, { key: `cancel:${b.id}:${seats.join(',')}`, reason: 'customer_cancellation', amountMinor });
      await this.audit.record('booking.cancelled', 'booking', b.id, { seats, amount_minor: amountMinor, whole_booking: remaining === 0 });
      const outboxIds = [
        await this.repo.outbox('seats:released', { screeningId: b.screeningId, seatIds: seats }),
        await this.repo.outbox('booking.cancelled', { bookingId: b.id, seatIds: seats }),
      ];
      return { b, refundId: intent?.id ?? null, outboxIds, seats };
    });

    await this.seatmaps.invalidate(ctx.tenantId, plan.b.screeningId);
    await this.outbox.drain(ctx, plan.outboxIds);
    const refund = plan.refundId ? await this.refunds.execute(ctx, plan.refundId) : null;
    const view = await this.scope(ctx, () => this.repo.byId(bookingId));
    return { booking_id: bookingId, reference: plan.b.reference, status: view!.status, cancelled_seat_ids: plan.seats, refund };
  }

  /**
   * FR-26: a manager cancels a screening. Live holds are released, every
   * confirmed booking is cancelled with a full refund intent, all in one
   * transaction; then the refunds run. Cancelling again resumes any refund
   * still pending and never refunds twice (the keys are per booking).
   */
  async cancelScreening(screeningId: string) {
    const ctx = currentTenant();
    const plan = await this.tenantDb.withTenantScope(async () => {
      const current = await this.screenings.get(screeningId); // 404 cross-tenant or out of theatre scope
      if (current.status !== 'cancelled') await this.screenings.transition(screeningId, 'cancelled');
      const holds = await db()
        .delete(seatLock)
        .where(and(eq(seatLock.screeningId, screeningId), eq(seatLock.status, 'held')))
        .returning({ seatId: seatLock.seatId });
      const confirmed = await db()
        .select()
        .from(booking)
        .where(and(eq(booking.screeningId, screeningId), inArray(booking.status, ['confirmed', 'cancelled'])));
      const refundIds: string[] = [];
      const outboxIds: number[] = [];
      for (const b of confirmed) {
        const live = await db().select({ seatId: ticket.seatId }).from(ticket).where(and(eq(ticket.bookingId, b.id), ne(ticket.status, 'void')));
        if (live.length) {
          await this.voidSeats(b.id, screeningId, live.map((t) => t.seatId));
          await this.repo.setStatus(b.id, 'confirmed', 'cancelled');
          outboxIds.push(await this.repo.outbox('booking.cancelled', { bookingId: b.id, reason: 'screening_cancelled' }));
        }
        const intent = await this.refunds.recordIntent(b.id, { key: `screening-cancel:${b.id}`, reason: 'screening_cancelled', amountMinor: null });
        if (intent && intent.status === 'pending') refundIds.push(intent.id);
      }
      outboxIds.push(await this.repo.outbox('screening:cancelled', { screeningId }));
      await this.audit.record('screening.cancellation_settled', 'screening', screeningId, {
        released_holds: holds.length,
        bookings: confirmed.length,
        refunds: refundIds.length,
      });
      return { holds: holds.length, bookings: confirmed.length, refundIds, outboxIds };
    });

    await this.seatmaps.invalidate(ctx.tenantId, screeningId);
    await this.outbox.drain(ctx, plan.outboxIds);
    const refunds = [];
    for (const id of plan.refundIds) refunds.push(await this.refunds.execute(ctx, id));
    return {
      screening_id: screeningId,
      status: 'cancelled',
      released_holds: plan.holds,
      cancelled_bookings: plan.bookings,
      refunds: { count: refunds.length, succeeded: refunds.filter((r) => r.status === 'succeeded').length },
    };
  }

  /** Voids tickets and deletes their sold rows: the seats are on sale again at COMMIT (FR-63). */
  private async voidSeats(bookingId: string, screeningId: string, seatIds: string[]) {
    await db()
      .update(ticket)
      .set({ status: 'void', voidedAt: new Date() })
      .where(and(eq(ticket.bookingId, bookingId), inArray(ticket.seatId, seatIds), eq(ticket.status, 'valid')));
    await db()
      .delete(seatLock)
      .where(and(eq(seatLock.screeningId, screeningId), inArray(seatLock.seatId, seatIds), eq(seatLock.bookingId, bookingId)));
  }

  private scope<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));
  }
}
