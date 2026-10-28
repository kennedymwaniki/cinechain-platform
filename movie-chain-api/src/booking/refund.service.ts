import { Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { AuditLog } from '../audit/audit-log.service';
import { booking, loyaltyLedger } from '../db/schema/booking';
import { payment, paymentRefund, type PaymentRefund } from '../db/schema/payment';
import { tenantCustomer } from '../db/schema/tenant-customer';
import { Metrics } from '../metrics/metrics.service';
import { PaymentProviders } from '../payment/payment-providers';
import { type Currency, money } from '../shared/money';
import { currentTenant, db, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';

export interface RefundOutcome {
  refund_id: string;
  amount: { amount_minor: number; currency: string };
  status: 'pending' | 'succeeded' | 'failed';
}

/**
 * Refunds, in two halves:
 *   recordIntent — INSIDE the caller's transaction, so a cancellation and its
 *                  refund intent commit together (the trigger refuses any
 *                  amount beyond the capture, FR-64);
 *   execute      — the provider call, OUTSIDE any transaction, then a short
 *                  one to record the outcome.
 * A crash between the two leaves a `pending` refund, which the reconciler
 * retries. Every refund has its own idempotency key, so a retry is never a
 * second refund at the provider either.
 */
@Injectable()
export class RefundService {
  private readonly log = new Logger(RefundService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly providers: PaymentProviders,
    private readonly metrics: Metrics,
    private readonly audit: AuditLog,
  ) {}

  /** Call inside a tenant scope. `amountMinor` null = everything not yet refunded. Idempotent on `key`. */
  async recordIntent(bookingId: string, v: { key: string; reason: string; amountMinor: number | null }): Promise<PaymentRefund | null> {
    const [prior] = await db().select().from(paymentRefund).where(eq(paymentRefund.idempotencyKey, v.key));
    if (prior) return prior;
    const [p] = await db().select().from(payment).where(and(eq(payment.bookingId, bookingId), eq(payment.status, 'captured')));
    if (!p) return null;
    const [{ refunded }] = (await db()
      .select({ refunded: sql<string>`coalesce(sum(${paymentRefund.amountMinor}), 0)` })
      .from(paymentRefund)
      .where(and(eq(paymentRefund.paymentId, p.id), ne(paymentRefund.status, 'failed')))) as [{ refunded: string }];
    const amountMinor = v.amountMinor ?? p.amountMinor - Number(refunded);
    if (amountMinor <= 0) return null;
    const [r] = await db()
      .insert(paymentRefund)
      .values({ tenantId: currentTenant().tenantId, paymentId: p.id, amountMinor, currency: p.currency, reason: v.reason, idempotencyKey: v.key })
      .returning();
    await this.audit.record('payment.refund_requested', 'payment', p.id, { amount_minor: amountMinor, reason: v.reason, booking_id: bookingId, refund_id: r!.id });
    return r!;
  }

  /** The provider call, then its outcome. Safe to repeat. */
  async execute(ctx: TenantContext, refundId: string): Promise<RefundOutcome> {
    const loaded = await this.scope(ctx, async () => {
      const [r] = await db().select().from(paymentRefund).where(eq(paymentRefund.id, refundId));
      if (!r) return null;
      const [p] = await db().select().from(payment).where(eq(payment.id, r.paymentId));
      if (r.status === 'pending') await db().update(paymentRefund).set({ attemptedAt: new Date() }).where(eq(paymentRefund.id, r.id));
      return { r, p: p! };
    });
    if (!loaded) throw new Error(`refund ${refundId} not found`);
    const { r, p } = loaded;
    if (r.status !== 'pending') return view(r);

    // Outside any transaction. Cash goes back over the counter: nothing to call.
    const result =
      p.provider === 'cash'
        ? ({ status: 'succeeded', refundRef: `cash_refund_${r.id}` } as const)
        : await this.providers
            .get(p.provider)!
            .refund({ idempotencyKey: r.idempotencyKey, providerRef: p.providerRef!, amount: money(r.amountMinor, r.currency as Currency) })
            .catch((e: Error) => ({ status: 'pending', refundRef: '', error: e.message }) as const);

    const done = await this.scope(ctx, async () => {
      const [row] = await db()
        .update(paymentRefund)
        .set(
          result.status === 'failed'
            ? { status: 'failed', failureReason: result.reason }
            : result.status === 'succeeded'
              ? { status: 'succeeded', providerRef: result.refundRef }
              : {}, // still pending at the provider: the reconciler asks again
        )
        .where(and(eq(paymentRefund.id, r.id), eq(paymentRefund.status, 'pending')))
        .returning();
      if (row?.status === 'succeeded') await this.reverseLoyalty(p.bookingId, row, p.amountMinor);
      return row ?? r;
    });
    if (result.status === 'failed') this.log.error(`PAGE: refund ${r.id} (booking ${p.bookingId}) failed at the provider: ${result.reason}`);
    return view(done);
  }

  async refund(ctx: TenantContext, bookingId: string, v: { key: string; reason: string; amountMinor: number | null }): Promise<RefundOutcome | null> {
    const intent = await this.scope(ctx, () => this.recordIntent(bookingId, v));
    return intent ? this.execute(ctx, intent.id) : null;
  }

  /**
   * FR-53, the most important failure path: the capture succeeded but the
   * seats were gone. Refund in full, at once, before the customer has to ask.
   */
  async refundSeatsLost(ctx: TenantContext, bookingId: string, reason = 'seats_lost_after_capture'): Promise<RefundOutcome | null> {
    this.metrics.inc('booking.seats_lost_after_capture', { tenant: ctx.tenantId });
    this.log.error(`PAGE: ${reason} for booking ${bookingId} (tenant ${ctx.tenantId}); refunding in full`);
    const intent = await this.scope(ctx, async () => {
      await db()
        .update(booking)
        .set({ status: 'expired', failureReason: reason })
        .where(and(eq(booking.id, bookingId), eq(booking.status, 'pending')));
      return this.recordIntent(bookingId, { key: `seats-lost:${bookingId}`, reason, amountMinor: null });
    });
    return intent ? this.execute(ctx, intent.id) : null;
  }

  /** For the reconciler: refunds still pending after `olderThanMs`. Call inside a tenant scope. */
  stalePending(olderThanMs: number) {
    return db()
      .select({ id: paymentRefund.id })
      .from(paymentRefund)
      .where(and(eq(paymentRefund.status, 'pending'), lt(paymentRefund.createdAt, new Date(Date.now() - olderThanMs))));
  }

  /**
   * FR-78: a refund takes back its SHARE of the award, rounded down, keyed on
   * the refund so a retry reverses nothing twice. Never below zero: points
   * already spent are recorded as a shortfall, not clawed.
   */
  private async reverseLoyalty(bookingId: string, refund: PaymentRefund, capturedMinor: number): Promise<void> {
    const ledger = await db().select().from(loyaltyLedger).where(eq(loyaltyLedger.bookingId, bookingId));
    const award = ledger.find((l) => l.kind === 'award');
    if (!award) return;
    const [{ refundedTotal }] = (await db()
      .select({ refundedTotal: sql<string>`coalesce(sum(${paymentRefund.amountMinor}), 0)` })
      .from(paymentRefund)
      .where(and(eq(paymentRefund.paymentId, refund.paymentId), eq(paymentRefund.status, 'succeeded')))) as [{ refundedTotal: string }];
    const due = Math.floor((award.points * Math.min(Number(refundedTotal), capturedMinor)) / capturedMinor);
    const already = ledger.filter((l) => l.kind === 'reversal').reduce((a, l) => a + -l.points + l.shortfall, 0);
    const owed = due - already;
    if (owed <= 0) return;

    const [cust] = await db().select().from(tenantCustomer).where(eq(tenantCustomer.email, award.email)).for('update');
    const taken = Math.min(cust?.loyaltyPoints ?? 0, owed);
    const inserted = await db()
      .insert(loyaltyLedger)
      .values({ tenantId: award.tenantId, bookingId, kind: 'reversal', ref: refund.id, email: award.email, points: -taken, shortfall: owed - taken })
      .onConflictDoNothing()
      .returning();
    if (inserted.length && taken > 0)
      await db()
        .update(tenantCustomer)
        .set({ loyaltyPoints: sql`${tenantCustomer.loyaltyPoints} - ${taken}` })
        .where(eq(tenantCustomer.email, award.email));
  }

  private scope<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));
  }
}

const view = (r: { id: string; amountMinor: number; currency: string; status: 'pending' | 'succeeded' | 'failed' }): RefundOutcome => ({
  refund_id: r.id,
  amount: { amount_minor: r.amountMinor, currency: r.currency },
  status: r.status,
});
