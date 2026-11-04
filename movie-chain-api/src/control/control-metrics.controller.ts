import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { and, count, eq, lt, sql } from 'drizzle-orm';
import { Gauge, Registry } from 'prom-client';
import { invoice, subscription } from '../db/schema/billing';
import { onboardingRun } from '../db/schema/control';
import { meteringUsage, offboardingRun } from '../db/schema/platform';
import { tenant } from '../db/schema/tenant';
import { ControlDb } from '../tenancy/control-db.provider';
import { ControlPublic } from './auth/operator-auth';

export const STUCK_AFTER_MS = 5 * 60_000;

/**
 * The control plane's scrape (it listens on 127.0.0.1 only). Exports the
 * OnboardingStuck input: runs still provisioning after 5 minutes, computed
 * at scrape time so it can never be stale.
 */
@ApiExcludeController()
@Controller('admin/metrics')
export class ControlMetricsController {
  private readonly registry = new Registry();

  constructor(private readonly db: ControlDb) {
    const control = this.db;
    new Gauge({
      name: 'cinechain_onboarding_stuck_runs',
      help: 'Onboarding runs provisioning for more than 5 minutes',
      registers: [this.registry],
      async collect() {
        const [row] = await control.platformTx((tx) =>
          tx
            .select({ n: count() })
            .from(onboardingRun)
            .where(and(eq(onboardingRun.status, 'provisioning'), lt(onboardingRun.updatedAt, new Date(Date.now() - STUCK_AFTER_MS)))),
        );
        this.set(row?.n ?? 0);
      },
    });

    // The platform at a glance, read at scrape time from the control plane's own
    // tables (registry and platform.*): counts and money, never tenant data.
    const grouped = (name: string, help: string, labelNames: string[], read: () => Promise<Array<{ labels: Record<string, string>; v: number }>>) =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: [this.registry],
        async collect() {
          this.reset();
          for (const r of await read()) this.set(r.labels, r.v);
        },
      });

    grouped('cinechain_tenants', 'Tenants by status and tier', ['status', 'tier'], async () =>
      (await control.platformTx((tx) => tx.select({ status: tenant.status, tier: tenant.tier, n: count() }).from(tenant).groupBy(tenant.status, tenant.tier))).map((r) => ({ labels: { status: r.status, tier: r.tier }, v: r.n })),
    );
    // id → slug, so dashboards can show a chain's NAME for the ids the application plane labels with.
    grouped('cinechain_tenant_info', 'One series per tenant: its slug, tier and status (value 1)', ['tenant', 'slug', 'tier', 'status'], async () =>
      (await control.platformTx((tx) => tx.select({ id: tenant.id, slug: tenant.slug, tier: tenant.tier, status: tenant.status }).from(tenant))).map((r) => ({
        labels: { tenant: r.id, slug: r.slug, tier: r.tier, status: r.status },
        v: 1,
      })),
    );
    grouped('cinechain_subscriptions', 'Subscriptions by status and plan', ['status', 'plan'], async () =>
      (await control.platformTx((tx) => tx.select({ status: subscription.status, plan: subscription.planCode, n: count() }).from(subscription).groupBy(subscription.status, subscription.planCode))).map((r) => ({
        labels: { status: r.status, plan: r.plan },
        v: r.n,
      })),
    );
    const invoices = async () =>
      control.platformTx((tx) =>
        tx
          .select({ status: invoice.status, currency: invoice.currency, n: count(), minor: sql<string>`coalesce(sum(${invoice.totalMinor}), 0)::text` })
          .from(invoice)
          .groupBy(invoice.status, invoice.currency),
      );
    grouped('cinechain_invoices', 'Invoices by status', ['status', 'currency'], async () => (await invoices()).map((r) => ({ labels: { status: r.status, currency: r.currency }, v: r.n })));
    // Minor units as a float sample: exact up to 2^53, far beyond any invoice book.
    grouped('cinechain_invoice_amount_minor', 'Invoice totals by status, minor units', ['status', 'currency'], async () =>
      (await invoices()).map((r) => ({ labels: { status: r.status, currency: r.currency }, v: Number(r.minor) })),
    );
    grouped('cinechain_invoices_overdue', 'Open invoices past their due date', ['currency'], async () =>
      (
        await control.platformTx((tx) =>
          tx
            .select({ currency: invoice.currency, n: count() })
            .from(invoice)
            .where(and(eq(invoice.status, 'open'), lt(invoice.dueAt, new Date())))
            .groupBy(invoice.currency),
        )
      ).map((r) => ({ labels: { currency: r.currency }, v: r.n })),
    );
    grouped('cinechain_offboarding_runs', 'Offboarding runs by status', ['status'], async () =>
      (await control.platformTx((tx) => tx.select({ status: offboardingRun.status, n: count() }).from(offboardingRun).groupBy(offboardingRun.status))).map((r) => ({ labels: { status: r.status }, v: r.n })),
    );
    grouped('cinechain_onboarding_runs', 'Onboarding runs by status', ['status'], async () =>
      (await control.platformTx((tx) => tx.select({ status: onboardingRun.status, n: count() }).from(onboardingRun).groupBy(onboardingRun.status))).map((r) => ({ labels: { status: r.status }, v: r.n })),
    );
    // This month's metered usage, summed over tenants (per-tenant usage lives in the billing API).
    grouped('cinechain_metered_usage', 'Metered usage this UTC month, all tenants', ['metric'], async () => {
      const period = new Date().toISOString().slice(0, 7);
      const [u] = await control.platformTx((tx) =>
        tx
          .select({
            requests: sql<string>`coalesce(sum(${meteringUsage.requests}), 0)::text`,
            bookings: sql<string>`coalesce(sum(${meteringUsage.bookings}), 0)::text`,
            tickets: sql<string>`coalesce(sum(${meteringUsage.tickets}), 0)::text`,
            hold_seconds: sql<string>`coalesce(sum(${meteringUsage.holdSeconds}), 0)::text`,
            storage_bytes: sql<string>`coalesce(sum(${meteringUsage.storageBytes}), 0)::text`,
          })
          .from(meteringUsage)
          .where(eq(meteringUsage.period, period)),
      );
      return Object.entries(u ?? {}).map(([metric, v]) => ({ labels: { metric }, v: Number(v) }));
    });
  }

  @ControlPublic()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
