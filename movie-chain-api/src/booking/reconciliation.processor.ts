import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { RegistryFanout } from '../common/elevated/cross-tenant-job';
import { booking } from '../db/schema/booking';
import { payment } from '../db/schema/payment';
import { PaymentProviders } from '../payment/payment-providers';
import { PaymentRepository } from '../payment/payment.repository';
import { toSystemContext } from '../tenancy/system-context';
import { db, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { RefundService } from './refund.service';

export const RECONCILE_QUEUE = 'booking.reconcile';
export const RECONCILE_EVERY_MS = 60_000;
/** A booking still pending this long after its capture has lost its request (crash, timeout). */
export const ORPHAN_AFTER_MS = 5 * 60_000;
export const REFUND_RETRY_AFTER_MS = 2 * 60_000;

export interface ReconcileJob {
  tenantId: string;
}

/**
 * Finds money without a sale and gives it back (§7.4, crash-after-capture):
 *   - a captured payment whose booking never confirmed → full refund;
 *   - a payment still pending at the provider → ask its status, and act on it;
 *   - a refund still pending → ask again (same idempotency key).
 * One ordinary tenant-scoped job per chain; the tick that enqueues them reads
 * only the tenant registry, which has no tenant data (see ELEVATED_JOBS.md).
 */
@Injectable()
export class Reconciler {
  private readonly log = new Logger(Reconciler.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly refunds: RefundService,
    private readonly payments: PaymentRepository,
    private readonly providers: PaymentProviders,
  ) {}

  async reconcile(tenantId: string, now = Date.now()) {
    const ctx = toSystemContext({ tenantId }, { kind: 'system', reason: 'reconciliation' });
    const scope = <T>(fn: () => Promise<T>) => runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));
    const cutoff = new Date(now - ORPHAN_AFTER_MS);
    const stuck = await scope(() =>
      db()
        .select({ bookingId: booking.id, paymentId: payment.id, paymentStatus: payment.status, provider: payment.provider })
        .from(booking)
        .innerJoin(payment, eq(payment.bookingId, booking.id))
        .where(and(eq(booking.status, 'pending'), lt(booking.createdAt, cutoff))),
    );

    let refunded = 0;
    for (const s of stuck) {
      let status = s.paymentStatus;
      if (status === 'pending' && s.provider !== 'cash') status = await this.resolvePending(ctx, s.paymentId, s.bookingId, s.provider);
      if (status === 'captured') {
        // Crash after capture: the customer has paid for seats they do not have.
        await this.refunds.refundSeatsLost(ctx, s.bookingId, 'orphaned_capture');
        refunded++;
      } else if (status === 'failed') {
        await scope(() => db().update(booking).set({ status: 'expired', failureReason: 'payment_failed' }).where(and(eq(booking.id, s.bookingId), eq(booking.status, 'pending'))));
      }
    }

    const pendingRefunds = await scope(() => this.refunds.stalePending(REFUND_RETRY_AFTER_MS));
    for (const r of pendingRefunds) await this.refunds.execute(ctx, r.id);
    // Inside the tenant's context, so the log line carries tenant_id without naming it here.
    if (refunded || pendingRefunds.length)
      await runWithTenant(ctx, async () => this.log.warn(`refunded ${refunded} orphaned capture(s), retried ${pendingRefunds.length} refund(s)`));
    return { orphansRefunded: refunded, refundsRetried: pendingRefunds.length };
  }

  /** Never re-capture: ask the provider what happened to OUR idempotency key. */
  private async resolvePending(ctx: TenantContext, paymentId: string, bookingId: string, provider: string) {
    const answer = await this.providers.get(provider)?.status(bookingId);
    return runWithTenant(ctx, () =>
      this.tenantDb.withTenantScope(async () => {
        if (answer?.status === 'captured') await this.payments.markCaptured(paymentId, { providerRef: answer.providerRef, capturedAt: answer.capturedAt });
        else if (answer?.status === 'failed') await this.payments.markFailed(paymentId, { providerRef: answer.providerRef, reason: answer.reason });
        else if (!answer) await this.payments.markFailed(paymentId, { providerRef: null, reason: 'never reached the provider' });
        const [p] = await db().select({ status: payment.status }).from(payment).where(eq(payment.id, paymentId));
        return p!.status;
      }),
    );
  }
}

/** Two job names on one queue: `fanout` (the tick) and `reconcile` (one tenant). */
@RegistryFanout('enqueues one tenant-scoped reconcile job per active chain; reads only the tenant registry')
@Processor(RECONCILE_QUEUE)
export class ReconciliationProcessor extends WorkerHost implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(ReconciliationProcessor.name);

  constructor(
    @InjectQueue(RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly tenantDb: TenantDb,
    private readonly reconciler: Reconciler,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('reconcile-all', { every: RECONCILE_EVERY_MS }, { name: 'fanout' }).catch((e: Error) => {
      this.log.warn(`could not schedule reconciliation: ${e.message}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(job: Job<ReconcileJob | Record<string, never>>): Promise<unknown> {
    if (job.name === 'fanout') return this.fanout();
    // The canonical worker shape: the tenant comes from the payload, and the
    // reconciler opens that tenant's scope before touching anything.
    return this.reconciler.reconcile((job.data as ReconcileJob).tenantId);
  }

  async fanout(): Promise<number> {
    const tenants = await this.tenantDb.registryQuery<{ id: string }>(`SELECT id FROM tenant WHERE status = 'active'`, []);
    const bucket = Math.floor(Date.now() / RECONCILE_EVERY_MS);
    await this.queue.addBulk(
      tenants.map((t) => ({ name: 'reconcile', data: { tenantId: t.id }, opts: { jobId: `reconcile-${t.id}-${bucket}`, removeOnComplete: true, attempts: 3 } })),
    );
    return tenants.length;
  }
}
