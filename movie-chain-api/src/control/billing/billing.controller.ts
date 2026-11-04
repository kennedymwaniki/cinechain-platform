import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors/api-error';
import { createZodDto } from '../../common/validation/zod-dto';
import { Uuid } from '../../common/validation/uuid.pipe';
import { plan, subscription } from '../../db/schema/billing';
import { tenant } from '../../db/schema/tenant';
import { ControlDb } from '../../tenancy/control-db.provider';
import { CostAllocator } from './cost-allocator.service';
import { DunningService } from './dunning.service';
import { InvoiceGenerator } from './invoice.generator';

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');

export class SubscribeDto extends createZodDto(
  z
    .object({
      plan_code: z.string().min(2).max(41),
      trial_days: z.number().int().min(0).max(90).default(0),
      grace_days: z.number().int().min(0).max(90).default(14),
      payment_method_ref: z.string().min(3).max(200).optional(), // a token at the platform's billing provider
    })
    .strict(),
) {}
export class InfraCostDto extends createZodDto(
  z.object({ currency: z.string().length(3), total_minor: z.number().int().min(0), source: z.string().min(3).max(200) }).strict(),
) {}
export class PeriodQuery extends createZodDto(z.object({ period }).strict()) {}

/** Control plane, operators only. Subscription billing — never the ticket payment path. */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('admin')
export class BillingController {
  constructor(
    private readonly db: ControlDb,
    private readonly invoices: InvoiceGenerator,
    private readonly costs: CostAllocator,
    private readonly dunning: DunningService,
  ) {}

  @Get('plans')
  plans() {
    return this.db.platformTx((tx) => tx.select().from(plan).where(eq(plan.active, true)).orderBy(asc(plan.basePriceMinor)));
  }

  @Post('tenants/:id/subscription')
  async subscribe(@Param('id', Uuid) tenantId: string, @Body() b: SubscribeDto) {
    return this.db.platformTx(async (tx) => {
      const [t] = await tx.select({ id: tenant.id, tier: tenant.tier }).from(tenant).where(eq(tenant.id, tenantId));
      if (!t) throw notFound();
      const [p] = await tx.select().from(plan).where(and(eq(plan.code, b.plan_code), eq(plan.active, true)));
      if (!p) throw unprocessable('unknown_plan', `No active plan "${b.plan_code}"`);
      const [live] = await tx.select({ id: subscription.id }).from(subscription).where(and(eq(subscription.tenantId, tenantId), ne(subscription.status, 'cancelled')));
      if (live) throw conflict('already_subscribed', 'This tenant already has a live subscription');
      const [s] = await tx
        .insert(subscription)
        .values({
          tenantId,
          planCode: p.code,
          status: b.trial_days > 0 ? 'trialing' : 'active',
          trialEndsAt: b.trial_days > 0 ? new Date(Date.now() + b.trial_days * 86_400_000) : null,
          graceDays: b.grace_days,
          paymentMethodRef: b.payment_method_ref ?? null,
        })
        .returning();
      // The plan's tier IS the tenant's tier: limits follow the subscription.
      await tx.update(tenant).set({ tier: p.tier }).where(eq(tenant.id, tenantId));
      return s;
    });
  }

  @Get('tenants/:id/invoices')
  list(@Param('id', Uuid) tenantId: string) {
    return this.invoices.invoicesFor(tenantId);
  }

  @Get('invoices/:id/reconciliation')
  async reconcile(@Param('id', Uuid) id: string) {
    const mismatches = await this.invoices.reconcile(id);
    return { reconciles: mismatches.length === 0, mismatches };
  }

  @Post('billing/periods/:period/close')
  @HttpCode(200)
  close(@Param('period') p: string) {
    return this.invoices.closePeriod(period.parse(p));
  }

  @Put('billing/infra-cost/:period')
  recordBill(@Param('period') p: string, @Body() b: InfraCostDto) {
    return this.costs.recordBill({ period: period.parse(p), currency: b.currency, totalMinor: b.total_minor, source: b.source });
  }

  @Get('billing/cost-per-tenant')
  async costPerTenant(@Query() q: PeriodQuery) {
    return this.costs.allocate(q.period);
  }

  /** Charge an open invoice now, outside the retry schedule (a new card, an operator retry). */
  @Post('invoices/:id/collect')
  @HttpCode(200)
  async collect(@Param('id', Uuid) id: string) {
    return { result: await this.dunning.collectNow(id) };
  }

  /** Runs one dunning pass now (it also runs on a schedule). */
  @Post('billing/dunning/run')
  @HttpCode(200)
  async runDunning() {
    const trialsEnded = await this.dunning.endTrials();
    const results: Record<string, string> = {};
    for (const i of await this.dunning.openInvoices()) results[i.invoiceId] = await this.dunning.step(i.invoiceId);
    return { trials_ended: trialsEnded, invoices: results };
  }
}
