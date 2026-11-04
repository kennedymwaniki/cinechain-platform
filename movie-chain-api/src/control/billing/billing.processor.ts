import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { RegistryFanout } from '../../common/elevated/cross-tenant-job';
import { DunningService } from './dunning.service';
import { InvoiceGenerator } from './invoice.generator';

export const BILLING_QUEUE = 'control.billing';
export const BILLING_EVERY_MS = 60 * 60_000;

export interface DunningJob {
  tenantId: string;
  invoiceId: string;
}

const previousPeriod = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

/**
 * Hourly: close last month (idempotent — an invoice per tenant per period),
 * end finished trials, and fan out one `dunning` job per open invoice, with
 * the tenant in its payload. The tick reads only platform billing rows, never
 * a tenant table; it is not one of the two elevated jobs.
 */
@RegistryFanout('closes the previous period and enqueues one dunning job per open invoice; reads only platform billing tables')
@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(BillingProcessor.name);

  constructor(
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
    private readonly invoices: InvoiceGenerator,
    private readonly dunning: DunningService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('billing-tick', { every: BILLING_EVERY_MS }, { name: 'tick' }).catch((e: Error) => this.log.warn(`could not schedule billing: ${e.message}`));
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(job: Job<DunningJob | Record<string, never>>): Promise<unknown> {
    if (job.name === 'dunning') return this.dunning.step((job.data as DunningJob).invoiceId);
    const now = new Date();
    const closed = await this.invoices.closePeriod(previousPeriod(now), now);
    const trials = await this.dunning.endTrials(now);
    const open = await this.dunning.openInvoices();
    const bucket = Math.floor(now.getTime() / BILLING_EVERY_MS);
    await this.queue.addBulk(open.map((o) => ({ name: 'dunning', data: o, opts: { jobId: `dunning-${o.invoiceId}-${bucket}`, removeOnComplete: true, attempts: 3 } })));
    return { closed, trials_ended: trials, dunning_jobs: open.length };
  }
}
