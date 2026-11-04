import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { dunningNotice, type DunningStage, invoice, subscription, subscriptionPayment } from '../../db/schema/billing';
import { tenant } from '../../db/schema/tenant';
import { StubGateway } from '../../payment/providers/stub-gateway';
import { type Currency, money } from '../../shared/money';
import { ControlDb } from '../../tenancy/control-db.provider';

const DAY_MS = 24 * 3600_000;
/** Payment retries, in days after the due date. The first attempt is on the due date itself. */
export const RETRY_DAYS = [0, 1, 3, 7] as const;
/** The final notice goes out this long before suspension. */
export const FINAL_NOTICE_DAYS = 3;

/**
 * The PLATFORM's billing provider account — not a cinema's. Subscription
 * payments never touch the ticket payment path: a different account, a
 * different reconciliation, and their own idempotency namespace ('sub:…').
 */
export class SubscriptionBillingGateway extends StubGateway {}

export type Notifier = (tenantId: string, stage: DunningStage, detail: Record<string, unknown>) => Promise<void> | void;

/**
 * Dunning: trial → active → past_due → suspended, and back to active on
 * payment. Every step takes `now`, so the schedule is testable to the day.
 * Suspension happens only once the subscription's grace period has fully
 * elapsed since the due date; reactivation restores the tenant with every
 * row it had (nothing is deleted on suspension).
 */
@Injectable()
export class DunningService {
  private readonly log = new Logger(DunningService.name);
  readonly notices: { tenantId: string; stage: DunningStage; detail: Record<string, unknown> }[] = [];
  private notifier: Notifier = (tenantId, stage, detail) => {
    this.notices.push({ tenantId, stage, detail });
    this.log.log(`dunning notice: ${stage}`);
  };

  constructor(
    private readonly db: ControlDb,
    readonly gateway: SubscriptionBillingGateway,
  ) {}

  setNotifier(n: Notifier): void {
    this.notifier = n;
  }

  /** Open invoices of tenants not cancelled: the fan-out's input. */
  openInvoices(): Promise<{ tenantId: string; invoiceId: string }[]> {
    return this.db.platformTx((tx) =>
      tx
        .select({ tenantId: invoice.tenantId, invoiceId: invoice.id })
        .from(invoice)
        .where(eq(invoice.status, 'open'))
        .orderBy(asc(invoice.dueAt)),
    );
  }

  /** Trials that have ended become active. */
  async endTrials(now = new Date()): Promise<number> {
    const rows = await this.db.platformTx((tx) =>
      tx
        .update(subscription)
        .set({ status: 'active', updatedAt: now })
        .where(and(eq(subscription.status, 'trialing'), sql`${subscription.trialEndsAt} <= ${now}`))
        .returning({ id: subscription.id }),
    );
    return rows.length;
  }

  /**
   * An attempt OUTSIDE the retry schedule: the customer updated their card, or
   * an operator retries by hand. Same path, same idempotency namespace.
   */
  collectNow(invoiceId: string, now = new Date()) {
    return this.step(invoiceId, now, true);
  }

  /** One invoice's dunning step at `now`: maybe charge, maybe notify, maybe suspend. Idempotent. */
  async step(invoiceId: string, now = new Date(), force = false): Promise<'paid' | 'retry_later' | 'failed' | 'suspended' | 'nothing'> {
    const state = await this.db.platformTx(async (tx) => {
      const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
      if (!inv || inv.status !== 'open') return null;
      const [sub] = await tx.select().from(subscription).where(eq(subscription.id, inv.subscriptionId));
      const attempts = await tx.select().from(subscriptionPayment).where(eq(subscriptionPayment.invoiceId, invoiceId));
      return { inv, sub: sub!, attempts };
    });
    if (!state) return 'nothing';
    const { inv, sub, attempts } = state;
    const daysLate = Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY_MS);
    if (now < inv.dueAt && !force) return 'nothing';

    // Charge if a retry is due (attempt n happens on day RETRY_DAYS[n-1]).
    const next = attempts.length + 1;
    const due = force || (next <= RETRY_DAYS.length && daysLate >= RETRY_DAYS[next - 1]!);
    if (due && sub.status !== 'cancelled') {
      const key = `sub:${inv.id}:${next}`;
      const r = this.gateway.charge(key, money(inv.totalMinor, inv.currency as Currency));
      const ok = r.outcome === 'captured';
      await this.db.platformTx(async (tx) => {
        await tx
          .insert(subscriptionPayment)
          .values({ invoiceId: inv.id, attempt: next, idempotencyKey: key, status: ok ? 'succeeded' : 'failed', providerRef: r.ref, failureReason: ok ? null : 'declined', attemptedAt: now })
          .onConflictDoNothing();
        if (ok) {
          await tx.update(invoice).set({ status: 'paid', paidAt: now }).where(and(eq(invoice.id, inv.id), eq(invoice.status, 'open')));
          const wasSuspended = sub.status === 'suspended';
          await tx.update(subscription).set({ status: 'active', pastDueSince: null, suspendedAt: null, updatedAt: now }).where(eq(subscription.id, sub.id));
          // Reactivation restores service; nothing was deleted on suspension, so nothing is lost.
          if (wasSuspended) await tx.update(tenant).set({ status: 'active' }).where(and(eq(tenant.id, sub.tenantId), eq(tenant.status, 'suspended')));
        } else if (sub.status === 'active' || sub.status === 'trialing') {
          await tx.update(subscription).set({ status: 'past_due', pastDueSince: now, updatedAt: now }).where(eq(subscription.id, sub.id));
        }
      });
      if (ok) {
        if (sub.status === 'suspended') await this.notify(inv.id, sub.tenantId, 'reactivated', 0, { invoice: inv.number });
        return 'paid';
      }
      await this.notify(inv.id, sub.tenantId, 'payment_failed', next, { invoice: inv.number, attempt: next });
      if (next < RETRY_DAYS.length) await this.notify(inv.id, sub.tenantId, 'retry_scheduled', next, { invoice: inv.number, next_attempt_day: RETRY_DAYS[next] });
    }

    // Suspension: ONLY once the full grace period has elapsed since the due date.
    if (daysLate >= sub.graceDays - FINAL_NOTICE_DAYS && daysLate < sub.graceDays && sub.status !== 'suspended')
      await this.notify(inv.id, sub.tenantId, 'final_notice', 0, { invoice: inv.number, suspends_in_days: sub.graceDays - daysLate });
    if (daysLate >= sub.graceDays && sub.status !== 'suspended' && sub.status !== 'cancelled') {
      await this.db.platformTx(async (tx) => {
        await tx.update(subscription).set({ status: 'suspended', suspendedAt: now, updatedAt: now }).where(eq(subscription.id, sub.id));
        // Logins blocked, data kept (FR-6). Step 27's suspend adds hold release and queue pausing.
        await tx.update(tenant).set({ status: 'suspended' }).where(and(eq(tenant.id, sub.tenantId), inArray(tenant.status, ['active'])));
      });
      await this.notify(inv.id, sub.tenantId, 'suspended', 0, { invoice: inv.number, days_late: daysLate });
      return 'suspended';
    }
    return due ? 'failed' : 'retry_later';
  }

  /** Each stage is announced once per invoice (and attempt). */
  private async notify(invoiceId: string, tenantId: string, stage: DunningStage, attempt: number, detail: Record<string, unknown>) {
    const fresh = await this.db.platformTx((tx) =>
      tx.insert(dunningNotice).values({ invoiceId, stage, attempt }).onConflictDoNothing().returning({ stage: dunningNotice.stage }),
    );
    if (fresh.length) await this.notifier(tenantId, stage, detail);
  }
}
