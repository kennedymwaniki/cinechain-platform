import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { BookingService } from '../booking/booking.service';
import { OutboxRelay } from '../booking/outbox.relay';
import { toSystemContext } from '../tenancy/system-context';
import { runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { Notifier } from './notifier';
import { Metrics } from '../observability/metrics.module';

export const NOTIFICATION_QUEUE = 'notification';

export interface NotificationJob {
  tenantId: string;
  kind: 'booking.confirmed' | 'booking.cancelled';
  bookingId: string;
}

/** Committed bookings become notification jobs (FR-55: within 30 s). */
@Injectable()
export class NotificationEnqueuer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelay,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue<NotificationJob>,
  ) {}

  onModuleInit(): void {
    for (const kind of ['booking.confirmed', 'booking.cancelled'] as const)
      this.relay.on(kind, async (tenantId, p) => {
        const bookingId = String(p.bookingId);
        await this.queue.add(kind, { tenantId, kind, bookingId }, {
          jobId: `${kind}:${bookingId}:${Array.isArray(p.seatIds) ? (p.seatIds as string[]).join(',') : 'all'}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        });
      });
  }
}

/**
 * THE CANONICAL WORKER PATTERN: the tenant is in the payload, and
 * runWithTenant is the processor's first action. A delivery failure fails the
 * JOB (and BullMQ retries it); the booking stays confirmed (FR-55).
 */
@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly bookings: BookingService,
    private readonly notifier: Notifier,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(job: Job<NotificationJob>): Promise<string> {
    const { tenantId, kind } = job.data;
    try {
      const outcome = await this.deliver(job);
      this.metrics.inc('notification.total', { tenant: tenantId, kind, outcome: outcome === 'sent' ? 'sent' : 'skipped_no_contact' });
      return outcome;
    } catch (e) {
      this.metrics.inc('notification.total', { tenant: tenantId, kind, outcome: 'failed' });
      throw e;
    }
  }

  private async deliver(job: Job<NotificationJob>): Promise<string> {
    const { tenantId, kind, bookingId } = job.data;
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason: 'notification' }), async () => {
      const view = await this.tenantDb.withTenantScope(() => this.bookings.view(bookingId));
      const chain = (await this.registry.byId(tenantId))?.name ?? 'your cinema';
      if (!view.contact) return 'no contact'; // a box-office walk-in left none
      const show = view.screening ? `${view.screening.film}, ${view.screening.theatre}, ${new Date(view.screening.starts_at).toUTCString()}` : '';
      if (kind === 'booking.confirmed') {
        const lines = view.tickets.map((t) => `Row ${t.seat.row} seat ${t.seat.number}: ${t.code}`).join('\n');
        await this.notifier.email(view.contact.email, `${chain}: your tickets (${view.reference})`, `${show}\n\n${lines}\n\nManage: ${view.manage_token ?? ''}`);
        if (view.contact.phone) await this.notifier.sms(view.contact.phone, `${chain} ${view.reference}: ${view.tickets.length} ticket(s). ${show}`);
      } else {
        await this.notifier.email(view.contact.email, `${chain}: booking ${view.reference} cancelled`, `${show}\nAny refund due is on its way to your original payment method.`);
      }
      return 'sent';
    });
  }
}
