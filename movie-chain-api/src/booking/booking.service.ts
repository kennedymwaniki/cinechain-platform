import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditLog } from '../audit/audit-log.service';
import type { HoldClaims } from '../auth/token-verifier';
import { PricingService } from '../catalogue/pricing.service';
import { conflict, notFound, unprocessable } from '../common/errors/api-error';
import { PaymentRequiredError } from '../common/errors/domain-errors';
import type { Booking } from '../db/schema/booking';
import type { PaymentProviderName, TenderType } from '../db/schema/payment';
import type { ScreenFormat, SeatClass } from '../db/schema/venue';
import { holdTokenInvalid, HoldTokenService } from '../inventory/hold-token.service';
import { RedisLocks } from '../inventory/redis-locks';
import { SeatmapService } from '../inventory/seatmap.service';
import type { CaptureResult, PaymentMethod } from '../payment/payment.provider';
import { PaymentProviders } from '../payment/payment-providers';
import { PaymentRepository } from '../payment/payment.repository';
import { PaymentWebhookService } from '../payment/payment-webhook.service';
import { RedisHealthBreaker } from '../redis/redis-health.breaker';
import { type Currency, money, toWire } from '../shared/money';
import { Doors } from '../tenancy/doors';
import { toSystemContext } from '../tenancy/system-context';
import { type Actor, currentTenant, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { TicketCodeService } from '../ticketing/ticket-code.service';
import { BookingRepository } from './booking.repository';
import { OutboxRelay } from './outbox.relay';
import { newReference, prefixFor } from './reference.generator';
import { BookingTokenService } from './booking-token.service';
import { TicketQrService } from '../ticketing/qr.service';
import { Metrics } from '../observability/metrics.module';
import { RefundService } from './refund.service';

/** Never start a capture if the hold could die before it finishes (§7.4). */
export const MIN_SECONDS_TO_CAPTURE = 45;
const ENDPOINT = 'POST /bookings';

export interface Contact {
  name: string;
  email: string;
  phone?: string | undefined;
}

export interface CheckoutRequest {
  holdToken: string;
  idempotencyKey: string;
  requestHash: string;
  actor: Actor;
  consumer: { id: string; emailVerified: boolean } | null;
  /** FR-77 inline link: decided by the caller, which asks the identity plane. */
  linksCustomer: boolean;
  method: PaymentMethod;
  contact: Contact | null;
  /** Box office (FR-57): the staff context, the tender, and the clerk. */
  boxOffice?: { ctx: TenantContext; tender: Exclude<TenderType, 'online'>; clerkId: string };
}

export class SeatsLostError extends PaymentRequiredError {
  constructor(extra: Record<string, unknown>) {
    super('seats_lost_payment_refunded', 'Your hold expired before payment completed. You have been refunded in full.', extra);
  }
}

/**
 * Hold → booking. THE ORDERING IS THE DESIGN; do not rearrange it:
 *   1. claim the idempotency key, COMMIT   (a retry during capture sees in_progress)
 *   2. read the hold; refuse under 45 s    (Postgres clock)
 *   3. price; booking=pending + payment intent, COMMIT  (a crash after capture is a detectable orphan)
 *   4. capture — outside every transaction (~20 s for M-Pesa; never pin a pooled connection)
 *   5. one statement flips held → sold, with tickets, customer, loyalty, outbox, in ONE transaction
 *   6. release Redis; drain the outbox      (Postgres is now the record)
 */
@Injectable()
export class BookingService implements OnModuleInit {
  private readonly log = new Logger(BookingService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly doors: Doors,
    private readonly tokens: HoldTokenService,
    private readonly pricing: PricingService,
    private readonly repo: BookingRepository,
    private readonly payments: PaymentRepository,
    private readonly providers: PaymentProviders,
    private readonly webhooks: PaymentWebhookService,
    private readonly refunds: RefundService,
    private readonly codes: TicketCodeService,
    private readonly locks: RedisLocks,
    private readonly breaker: RedisHealthBreaker,
    private readonly seatmaps: SeatmapService,
    private readonly outbox: OutboxRelay,
    private readonly audit: AuditLog,
    private readonly bookingTokens: BookingTokenService,
    private readonly qr: TicketQrService,
    private readonly metrics: Metrics,
  ) {}

  onModuleInit(): void {
    this.metrics.inc('double_sale_total', { tenant: 'none' }, 0); // the series exists before it is ever needed
    // A capture that was still pending when we answered is settled later by the provider's callback.
    this.webhooks.onSettled((e) => this.settleLate(e.tenantId, e.bookingId));
  }

  async checkout(req: CheckoutRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const claims = await this.tokens.verify(req.holdToken, {});
    const ctx = await this.contextFor(claims, req);
    const scope = <T>(fn: () => Promise<T>) => runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));

    // 1. Idempotency, committed on its own.
    const claimed = await scope(async () => {
      if (await this.repo.claimKey(req.idempotencyKey, ENDPOINT, req.requestHash)) return null;
      const prior = await this.repo.priorKey(req.idempotencyKey, ENDPOINT);
      if (!prior) throw conflict('idempotency_in_progress', 'A request with this key is still in progress');
      if (prior.requestHash !== req.requestHash)
        throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request');
      if (prior.status !== 'completed') throw conflict('idempotency_in_progress', 'A request with this key is still in progress');
      return { status: prior.responseStatus ?? 200, body: prior.responseBody as Record<string, unknown> };
    });
    if (claimed) return { ...claimed, body: { ...claimed.body, replayed: true } };

    let booking: Booking;
    try {
      // 2 + 3. Read the hold, price it, record the intent. Then COMMIT.
      booking = await scope(() => this.prepare(claims, req));
    } catch (e) {
      // Nothing was charged: let the client retry this key.
      await scope(() => this.repo.releaseKey(req.idempotencyKey, ENDPOINT)).catch(() => undefined);
      throw e;
    }

    // 4. Capture, outside every transaction.
    const capture = await this.capture(ctx, booking, req.method);

    // 5. One transaction: the sale, or nothing.
    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await this.finish(ctx, booking, capture);
    } catch (e) {
      if (e instanceof SeatsLostError) {
        result = { status: 402, body: { error: e.code, message: e.message, ...e.extra } };
        await scope(() => this.repo.completeKey(req.idempotencyKey, ENDPOINT, result.status, result.body));
      }
      throw e;
    }
    await scope(() => this.repo.completeKey(req.idempotencyKey, ENDPOINT, result.status, result.body));
    return result;
  }

  /** Where the tenant comes from: the server-signed token, cross-checked against the live screening. */
  private async contextFor(claims: HoldClaims, req: CheckoutRequest): Promise<TenantContext> {
    if (req.boxOffice) {
      // A clerk can sell only their own chain's holds; another chain's is simply not found.
      if (claims.tenant_id !== req.boxOffice.ctx.tenantId) throw notFound();
      return req.boxOffice.ctx;
    }
    if (claims.channel !== 'online') throw holdTokenInvalid();
    const owner = await this.doors.resolvePublishedScreening(claims.screening_id);
    if (!owner) throw conflict('screening_unavailable', 'This screening is no longer on sale');
    if (owner.tenantId !== claims.tenant_id) throw holdTokenInvalid();
    return toSystemContext(owner, req.actor);
  }

  private async prepare(claims: HoldClaims, req: CheckoutRequest): Promise<Booking> {
    const existing = await this.repo.liveBookingForHold(claims.hold_id);
    if (existing) throw conflict('hold_already_booked', 'This hold already has a booking in progress or confirmed');

    const hold = await this.repo.holdState(claims.hold_id);
    if (hold.seatIds.length !== claims.seat_ids.length)
      throw conflict('hold_expired', 'This hold has expired. Choose your seats again.');
    if (hold.secondsLeft < MIN_SECONDS_TO_CAPTURE)
      throw conflict('hold_expiring', `Less than ${MIN_SECONDS_TO_CAPTURE} seconds remain on this hold; extend it or choose again`, {
        seconds_left: Math.floor(hold.secondsLeft),
      });

    // Priced server-side, now. If the price moved since the hold was quoted, say so rather than charge a surprise.
    const { seats, show } = await this.repo.seatsAndShow(claims.screening_id, claims.seat_ids);
    if (!show || seats.length !== claims.seat_ids.length) throw notFound();
    let total = 0;
    for (const s of seats) {
      const p = await this.pricing.priceFor(s.seatClass as SeatClass, show.format as ScreenFormat, new Date());
      if (!p || p.currency !== claims.currency) throw unprocessable('price_unavailable', `No price is set for ${s.seatClass} seats`);
      total += p.amountMinor;
    }
    if (total !== claims.quoted_total_minor)
      throw conflict('price_changed', 'The price changed since these seats were held', {
        quoted: { amount_minor: claims.quoted_total_minor, currency: claims.currency },
        current: { amount_minor: total, currency: claims.currency },
      });

    const tenant = (await this.registry.byId(claims.tenant_id))!;
    const bookingId = randomUUID();
    const booking = await this.insertWithReference(prefixFor(tenant.bookingRefPrefix, tenant.slug), {
      id: bookingId,
      screeningId: claims.screening_id,
      holdId: claims.hold_id,
      channel: req.boxOffice ? 'box_office' : 'online',
      consumerId: req.consumer?.id ?? null,
      linksCustomer: req.linksCustomer,
      guestEmail: req.contact?.email ?? null,
      guestName: req.contact?.name ?? null,
      guestPhone: req.contact?.phone ?? (req.method.kind === 'mpesa' ? req.method.phone : null),
      seatIds: claims.seat_ids,
      totalMinor: total,
      currency: claims.currency,
      soldByStaff: req.boxOffice?.clerkId ?? null,
    });
    await this.payments.insertPending({
      bookingId,
      provider: req.method.kind as PaymentProviderName,
      tenderType: req.boxOffice?.tender ?? 'online',
      idempotencyKey: bookingId, // FR-51: OUR booking id, so a retry is never a second charge
      amountMinor: total,
      currency: claims.currency,
      cardToken: req.method.kind === 'card' ? req.method.cardToken : null,
      recordedByStaff: req.boxOffice?.clerkId ?? null,
    });
    return booking;
  }

  private async insertWithReference(prefix: string, v: Omit<Parameters<BookingRepository['insertBooking']>[0], 'reference'>) {
    for (let attempt = 0; ; attempt++) {
      try {
        // A savepoint per attempt: a reference collision must not abort the transaction.
        return await this.tenantDb.withTenantScope(() => this.repo.insertBooking({ ...v, reference: newReference(prefix) }));
      } catch (e) {
        const c = e as { cause?: { constraint?: string } };
        if (attempt < 4 && c.cause?.constraint === 'booking_tenant_id_reference_key') continue;
        throw e;
      }
    }
  }

  /** Step 4. No transaction is open here. */
  private async capture(ctx: TenantContext, booking: Booking, method: PaymentMethod): Promise<CaptureResult> {
    if (method.kind === 'cash') return { status: 'captured', providerRef: `cash_${booking.id}`, capturedAt: new Date() };
    const provider = this.providers.get(method.kind)!;
    const amount = money(booking.totalMinor, booking.currency as Currency);
    const result = await provider.capture({
      idempotencyKey: booking.id,
      amount,
      method,
      description: `${booking.reference} (${booking.seatIds.length} seat${booking.seatIds.length > 1 ? 's' : ''})`,
    });
    // Remember the provider's reference at once, so its webhook can find this payment.
    if (result.providerRef) {
      const ref = result.providerRef;
      await runWithTenant(ctx, () =>
        this.tenantDb.withTenantScope(async () => {
          const p = await this.payments.byIdempotencyKey(booking.id);
          if (p && !p.providerRef) await this.payments.setProviderRef(p.id, ref);
        }),
      );
    }
    return result;
  }

  /** Step 5 (and 6). Also the path a late webhook takes. */
  private async finish(ctx: TenantContext, booking: Booking, capture: CaptureResult): Promise<{ status: number; body: Record<string, unknown> }> {
    const scope = <T>(fn: () => Promise<T>) => runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));

    if (capture.status === 'pending') {
      return { status: 202, body: { ...(await scope(() => this.view(booking.id))), message: 'Waiting for the payment provider to confirm' } };
    }
    if (capture.status === 'failed') {
      await scope(async () => {
        const p = (await this.payments.byIdempotencyKey(booking.id))!;
        await this.payments.markFailed(p.id, { providerRef: capture.providerRef, reason: capture.reason });
        await this.repo.setStatus(booking.id, 'pending', 'expired', { failureReason: 'payment_failed' });
      });
      // The hold is untouched: the customer may try again with another method.
      throw conflict('payment_failed', 'The payment was not completed', { reason: capture.reason, reference: booking.reference });
    }

    // The capture happened: record it first, in its own commit, whatever follows.
    await scope(async () => {
      const p = (await this.payments.byIdempotencyKey(booking.id))!;
      await this.payments.markCaptured(p.id, { providerRef: capture.providerRef, capturedAt: capture.capturedAt, cardLast4: capture.cardLast4 });
    });

    let outboxIds: number[];
    try {
      outboxIds = await scope(async () => {
        const sold = await this.repo.convert({ bookingId: booking.id, screeningId: booking.screeningId, seatIds: booking.seatIds, holdId: booking.holdId });
        // Throwing rolls back any partial conversion: never half-sold.
        if (sold.length !== booking.seatIds.length) throw new LostSignal(booking.seatIds.filter((s) => !sold.includes(s)));
        return this.confirmSold(ctx, booking);
      });
    } catch (e) {
      if (!(e instanceof LostSignal)) throw e; // e.g. a failure at ticket insert: seats stay held; reconciliation refunds
      const refund = await this.refunds.refundSeatsLost(ctx, booking.id);
      throw new SeatsLostError({ reference: booking.reference, unavailable_seat_ids: e.lost, refund });
    }

    // 6. Postgres is now the record: drop the Redis keys and publish what committed.
    await this.breaker.attempt(() =>
      this.locks.release({ tenantId: ctx.tenantId, screeningId: booking.screeningId, holdId: booking.holdId, seatIds: booking.seatIds }),
    );
    await this.seatmaps.invalidate(ctx.tenantId, booking.screeningId);
    await this.outbox.drain(ctx, outboxIds);
    return { status: 201, body: await scope(() => this.view(booking.id)) };
  }

  /** Inside the step-5 transaction: tickets, customer, loyalty, audit, outbox. */
  private async confirmSold(ctx: TenantContext, booking: Booking): Promise<number[]> {
    const { seats, show } = await this.repo.seatsAndShow(booking.screeningId, booking.seatIds);
    const prices = new Map<string, number>();
    for (const s of seats)
      prices.set(s.id, (await this.pricing.priceFor(s.seatClass as SeatClass, show!.format as ScreenFormat, new Date()))!.amountMinor);
    // Prices are captured onto the tickets now; per-seat prices always sum to what was charged.
    const sum = [...prices.values()].reduce((a, b) => a + b, 0);
    if (sum !== booking.totalMinor) prices.set(seats[0]!.id, prices.get(seats[0]!.id)! + booking.totalMinor - sum);
    await this.insertTicketsOrAlarm(ctx, booking, () => this.repo.insertTickets(
      booking.seatIds.map((seatId) => {
        const id = randomUUID();
        return {
          id,
          bookingId: booking.id,
          screeningId: booking.screeningId,
          seatId,
          codeHash: TicketCodeService.hash(this.codes.codeFor(ctx.tenantId, id)),
          priceMinor: prices.get(seatId)!,
          currency: booking.currency,
        };
      }),
    ));

    if (booking.guestEmail) {
      // Link to the account only when it is VERIFIED (FR-77): otherwise anyone could
      // register someone else's e-mail and inherit their history.
      await this.repo.upsertCustomer(booking.guestEmail, booking.guestName, booking.linksCustomer ? booking.consumerId : null);
      const tenant = (await this.registry.byId(ctx.tenantId))!;
      const unit = 10 ** (booking.currency === 'UGX' || booking.currency === 'RWF' ? 0 : 2);
      const points = Math.floor(booking.totalMinor / unit) * tenant.loyaltyPointsPerUnit;
      if (points > 0) await this.repo.awardLoyalty(booking.id, booking.guestEmail, points);
    }

    await this.repo.setStatus(booking.id, 'pending', 'confirmed', { confirmedAt: new Date() });
    await this.audit.record('booking.confirmed', 'booking', booking.id, {
      reference: booking.reference,
      seats: booking.seatIds.length,
      total_minor: booking.totalMinor,
      channel: booking.channel,
    });
    return [
      // Hold and sale emit the SAME public event (§7.6): no tenant id, no hold id.
      await this.repo.outbox('seats:taken', { screeningId: booking.screeningId, seatIds: booking.seatIds }),
      await this.repo.outbox('booking.confirmed', { bookingId: booking.id, seats: booking.seatIds.length }),
    ];
  }

  /**
   * A second live ticket for one seat is refused by ticket_seat_live_idx. It
   * should be impossible (the conversion already decided); if it ever fires, a
   * core guarantee broke: count it — the DoubleSale alert pages on any — and fail.
   */
  private async insertTicketsOrAlarm<T>(ctx: TenantContext, booking: Booking, insert: () => Promise<T>): Promise<T> {
    try {
      return await insert();
    } catch (e) {
      if ((e as { cause?: { constraint?: string } }).cause?.constraint === 'ticket_seat_live_idx') {
        this.metrics.inc('double_sale_total', { tenant: ctx.tenantId });
        this.log.error(`DOUBLE SALE refused for booking ${booking.reference}`);
      }
      throw e;
    }
  }

  /** A capture that was pending at response time, settled by the provider's callback. */
  async settleLate(tenantId: string, bookingId: string): Promise<void> {
    const ctx = toSystemContext({ tenantId }, { kind: 'system', reason: 'payment callback' });
    const state = await runWithTenant(ctx, () =>
      this.tenantDb.withTenantScope(async () => ({
        booking: await this.repo.byId(bookingId),
        payment: await this.payments.byIdempotencyKey(bookingId),
      })),
    );
    if (!state.booking || state.booking.status !== 'pending' || !state.payment) return;
    if (state.payment.status === 'captured') {
      await this.finish(ctx, state.booking, {
        status: 'captured',
        providerRef: state.payment.providerRef!,
        capturedAt: state.payment.capturedAt!,
      }).catch((e: unknown) => {
        if (!(e instanceof SeatsLostError)) throw e;
        this.log.warn(`late capture for ${state.booking!.reference} found its seats gone; refunded`);
      });
    } else if (state.payment.status === 'failed') {
      await runWithTenant(ctx, () =>
        this.tenantDb.withTenantScope(() => this.repo.setStatus(bookingId, 'pending', 'expired', { failureReason: 'payment_failed' })),
      );
    }
  }

  async exists(bookingId: string): Promise<boolean> {
    return !!(await this.repo.byId(bookingId));
  }

  /** The booking as its owner sees it: tickets with their codes, no consumer id. */
  async view(bookingId: string) {
    const { tenantId } = currentTenant();
    const b = (await this.repo.byId(bookingId))!;
    const [{ seats, show }, tickets] = await Promise.all([this.repo.seatsAndShow(b.screeningId, b.seatIds), this.repo.ticketsFor([b.id])]);
    const seatById = new Map(seats.map((s) => [s.id, s]));
    return {
      booking_id: b.id,
      reference: b.reference,
      status: b.status,
      screening: show ? { id: b.screeningId, film: show.film, theatre: show.theatre, screen: show.screen, starts_at: show.startsAt.toISOString() } : null,
      total: toWire(money(b.totalMinor, b.currency as Currency)),
      contact: b.guestEmail ? { name: b.guestName, email: b.guestEmail, phone: b.guestPhone } : null,
      tickets: await Promise.all(
        tickets
        .filter((t) => t.status !== 'void')
        .map(async (t) => ({
          ticket_id: t.id,
          seat: { id: t.seatId, row: seatById.get(t.seatId)?.row, number: seatById.get(t.seatId)?.number },
          price: toWire(money(t.priceMinor, t.currency as Currency)),
          code: this.codes.codeFor(tenantId, t.id),
          qr_url: await this.qr.urlFor(tenantId, t.id),
          status: t.status,
        })),
      ),
      created_at: b.createdAt.toISOString(),
      // FR-73: the signed, expiring link to view or cancel this booking without an account.
      manage_token: show ? await this.bookingTokens.sign({ tenantId, bookingId: b.id, reference: b.reference, startsAt: show.startsAt }) : null,
    };
  }
}

/** Internal: the conversion matched fewer rows than the hold had. */
class LostSignal extends Error {
  constructor(readonly lost: string[]) {
    super('seats lost between capture and conversion');
  }
}
