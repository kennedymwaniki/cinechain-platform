import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { invoice, invoiceLine, plan, subscription, type Invoice } from '../../db/schema/billing';
import { meteringUsage } from '../../db/schema/platform';
import { ControlDb } from '../../tenancy/control-db.provider';
import { draftLines, METERS, totalOf, type Usage } from './invoice.math';

export const NET_DAYS = 14;
const DAY_MS = 24 * 3600_000;

/** First instant of the month AFTER `period` (UTC). */
export const periodEnd = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1));
};
export const periodStart = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
};

export interface Mismatch {
  invoice: string;
  line?: string;
  problem: string;
}

/**
 * Period close: metering_usage → invoices. One invoice per tenant per period
 * (UNIQUE), so closing twice issues nothing new. Lines copy the metered
 * quantities verbatim, which is what makes `reconcile` possible.
 */
@Injectable()
export class InvoiceGenerator {
  private readonly log = new Logger(InvoiceGenerator.name);

  constructor(private readonly db: ControlDb) {}

  async closePeriod(period: string, now = new Date()): Promise<{ issued: number; skipped: number }> {
    const end = periodEnd(period);
    if (now < end) throw new Error(`period ${period} has not ended yet`);
    const subs = await this.db.platformTx((tx) =>
      tx
        .select()
        .from(subscription)
        .where(and(inArray(subscription.status, ['trialing', 'active', 'past_due', 'suspended']), lt(subscription.createdAt, end))),
    );
    let issued = 0;
    for (const s of subs) if (await this.issue(s.id, period, now)) issued++;
    this.log.log(`closed ${period}: ${issued} invoice(s) issued, ${subs.length - issued} already existed`);
    return { issued, skipped: subs.length - issued };
  }

  /** Issues one subscription's invoice for `period`; false if it already exists. */
  private issue(subscriptionId: string, period: string, now: Date): Promise<boolean> {
    return this.db.platformTx(async (tx) => {
      const [s] = await tx.select().from(subscription).where(eq(subscription.id, subscriptionId)).for('update');
      if (!s) return false;
      const [existing] = await tx.select({ id: invoice.id }).from(invoice).where(and(eq(invoice.tenantId, s.tenantId), eq(invoice.period, period)));
      if (existing) return false;
      const [p] = await tx.select().from(plan).where(eq(plan.code, s.planCode));
      const [u] = await tx.select().from(meteringUsage).where(and(eq(meteringUsage.tenantId, s.tenantId), eq(meteringUsage.period, period)));
      const usage: Usage = {
        requests: u?.requests ?? 0,
        bookings: u?.bookings ?? 0,
        tickets: u?.tickets ?? 0,
        hold_seconds: u?.holdSeconds ?? 0,
        storage_bytes: u?.storageBytes ?? 0,
      };
      const lines = draftLines(p!, usage, { trialCoversPeriod: !!s.trialEndsAt && s.trialEndsAt >= periodEnd(period) });
      const [{ n }] = (await tx.execute(sql`SELECT nextval('platform.invoice_number_seq')::int AS n`)).rows as [{ n: number }];
      const [inv] = await tx
        .insert(invoice)
        .values({
          number: `CC-${period}-${String(n).padStart(6, '0')}`,
          tenantId: s.tenantId,
          subscriptionId: s.id,
          period,
          planCode: p!.code,
          currency: p!.currency,
          totalMinor: totalOf(lines),
          issuedAt: now,
          dueAt: new Date(now.getTime() + NET_DAYS * DAY_MS),
          ...(totalOf(lines) === 0 ? { status: 'paid' as const, paidAt: now } : {}),
        })
        .returning();
      await tx.insert(invoiceLine).values(lines.map((l, i) => ({ ...l, invoiceId: inv!.id, position: i + 1 })));
      return true;
    });
  }

  /**
   * Every metered line equals metering_usage for its tenant and period, every
   * amount re-derives from its own quantities, and the total is the sum of the
   * lines — to the minor unit. Returns what does not reconcile (empty = clean).
   */
  async reconcile(invoiceId: string): Promise<Mismatch[]> {
    return this.db.platformTx(async (tx) => {
      const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
      if (!inv) return [{ invoice: invoiceId, problem: 'no such invoice' }];
      const lines = await tx.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, invoiceId)).orderBy(asc(invoiceLine.position));
      const [u] = await tx.select().from(meteringUsage).where(and(eq(meteringUsage.tenantId, inv.tenantId), eq(meteringUsage.period, inv.period)));
      const metered: Record<(typeof METERS)[number], number> = {
        requests: u?.requests ?? 0,
        bookings: u?.bookings ?? 0,
        tickets: u?.tickets ?? 0,
        hold_seconds: u?.holdSeconds ?? 0,
        storage_bytes: u?.storageBytes ?? 0,
      };
      const out: Mismatch[] = [];
      for (const l of lines) {
        if ((METERS as readonly string[]).includes(l.kind) && l.meteredQuantity !== metered[l.kind as (typeof METERS)[number]])
          out.push({ invoice: inv.number, line: l.kind, problem: `metered ${l.meteredQuantity} on the invoice, ${metered[l.kind as (typeof METERS)[number]]} in metering_usage` });
        if (l.amountMinor !== l.billableUnits * l.unitPriceMinor) out.push({ invoice: inv.number, line: l.kind, problem: 'amount is not units × price' });
      }
      for (const m of METERS) if (!lines.some((l) => l.kind === m)) out.push({ invoice: inv.number, line: m, problem: 'no line for this meter' });
      const sum = totalOf(lines);
      if (sum !== inv.totalMinor) out.push({ invoice: inv.number, problem: `lines sum to ${sum}, total says ${inv.totalMinor}` });
      return out;
    });
  }

  invoicesFor(tenantId: string): Promise<(Invoice & { lines: unknown[] })[]> {
    return this.db.platformTx(async (tx) => {
      const invs = await tx.select().from(invoice).where(eq(invoice.tenantId, tenantId)).orderBy(asc(invoice.period));
      const lines = invs.length ? await tx.select().from(invoiceLine).where(inArray(invoiceLine.invoiceId, invs.map((i) => i.id))).orderBy(asc(invoiceLine.position)) : [];
      return invs.map((i) => ({ ...i, lines: lines.filter((l) => l.invoiceId === i.id) }));
    });
  }
}
