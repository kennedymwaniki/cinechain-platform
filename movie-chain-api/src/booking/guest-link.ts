import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { booking } from '../db/schema/booking';
import { tenantCustomer } from '../db/schema/tenant-customer';
import { ConsumerService } from '../identity/consumer.service';
import { Doors } from '../tenancy/doors';
import { toSystemContext } from '../tenancy/system-context';
import { db, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { Metrics } from '../observability/metrics.module';
import { TenantJobGate } from '../lifecycle/tenant-job-gate';

export const LINK_GUEST_QUEUE = 'identity.link-guest';

export interface LinkGuestJob {
  tenantId: string;
  consumerId: string;
  email: string;
}

/**
 * FR-77. When a consumer's e-mail becomes VERIFIED, find the chains holding
 * unlinked guest purchases under it (the fifth door: tenant ids only) and
 * enqueue ONE ordinary tenant-scoped job per chain. Never for an unverified
 * e-mail: otherwise registering someone else's address would hand you their
 * history.
 */
@Injectable()
export class GuestLinkFanout implements OnApplicationBootstrap {
  private readonly log = new Logger(GuestLinkFanout.name);

  constructor(
    private readonly consumers: ConsumerService,
    private readonly doors: Doors,
    @InjectQueue(LINK_GUEST_QUEUE) private readonly queue: Queue<LinkGuestJob>,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.onVerified(() => this.drain());
    void this.drain().catch((e: Error) => this.log.warn(`guest-link drain on boot failed: ${e.message}`));
  }

  /** Processes every pending consumer.verified event. Safe to call concurrently (SKIP LOCKED). */
  async drain(): Promise<number> {
    return this.consumers.drainVerified(async ({ consumerId, email }) => {
      for (const { tenantId } of await this.doors.tenantsWithUnlinkedGuest(email))
        await this.queue.add(
          'link',
          { tenantId, consumerId, email },
          { jobId: `link-${tenantId}-${consumerId}`, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true },
        );
    });
  }
}

/** The canonical worker shape: tenantId in the payload, runWithTenant first. Idempotent. */
@Processor(LINK_GUEST_QUEUE)
export class LinkGuestProcessor extends WorkerHost {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly gate: TenantJobGate,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async process(job: Job<LinkGuestJob>, token?: string): Promise<{ customers: number; bookings: number }> {
    const { tenantId, consumerId, email } = job.data;
    // Paused while the chain is suspended; dropped once it is offboarded (step 27).
    if ((await this.gate.check(job, token, tenantId)) === 'drop') return { customers: 0, bookings: 0 };
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason: 'link guest history' }), () =>
      this.tenantDb.withTenantScope(async () => {
        const customers = await db()
          .update(tenantCustomer)
          .set({ consumerId })
          .where(and(eq(tenantCustomer.email, email), isNull(tenantCustomer.consumerId)))
          .returning({ email: tenantCustomer.email });
        const bookings = await db()
          .update(booking)
          .set({ consumerId })
          .where(and(sql`${booking.guestEmail} = ${email}::citext`, isNull(booking.consumerId)))
          .returning({ id: booking.id });
        this.metrics.inc('guest_link.bookings_linked_total', { tenant: tenantId }, bookings.length);
        this.metrics.inc('guest_link.jobs_total', { tenant: tenantId });
        return { customers: customers.length, bookings: bookings.length };
      }),
    );
  }
}
