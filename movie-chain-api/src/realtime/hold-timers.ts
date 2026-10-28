import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { seatLock } from '../db/schema/inventory';
import { InventoryEvents } from '../inventory/inventory-events';
import { RedisLocks } from '../inventory/redis-locks';
import { RedisHealthBreaker } from '../redis/redis-health.breaker';
import { toSystemContext } from '../tenancy/system-context';
import { db, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { SeatEvents } from './seat-events';

export const HOLD_TIMER_QUEUE = 'realtime.hold-timers';
export const EXPIRING_WARNING_MS = 30_000;

export interface HoldTimerJob {
  tenantId: string;
  screeningId: string;
  holdId: string;
  seatIds: string[];
  expiresAt: string;
  kind: 'expiring' | 'expired';
}

/**
 * Turns hold lifecycle into live events: `seats:taken` on placement,
 * `seats:released` on release or expiry, and the private countdown events.
 * Expiry is a delayed job per hold — the Redis TTL frees the seat on its own;
 * this only TELLS everyone it happened.
 */
@Injectable()
export class HoldTimers implements OnModuleInit {
  constructor(
    private readonly inventory: InventoryEvents,
    private readonly events: SeatEvents,
    @InjectQueue(HOLD_TIMER_QUEUE) private readonly queue: Queue<HoldTimerJob>,
  ) {}

  onModuleInit(): void {
    this.inventory.on(async (e) => {
      if (e.kind === 'hold.placed') this.events.publish(e.tenantId, e.screeningId, 'seats:taken', e.seatIds, e.version);
      if (e.kind === 'hold.released') this.events.publish(e.tenantId, e.screeningId, 'seats:released', e.seatIds, e.version);
      if (e.kind === 'hold.extended') this.events.toHold(e.holdId, 'hold:extended', e.expiresAt);
      if (e.kind === 'hold.placed' || e.kind === 'hold.extended') await this.schedule({ ...e, expiresAt: e.expiresAt.toISOString() });
    });
  }

  private async schedule(e: Omit<HoldTimerJob, 'kind'>): Promise<void> {
    const at = Date.parse(e.expiresAt);
    for (const [kind, when] of [
      ['expiring', at - EXPIRING_WARNING_MS],
      ['expired', at + 250],
    ] as const)
      await this.queue.add(kind, { ...e, kind }, { delay: Math.max(0, when - Date.now()), jobId: `${e.holdId}:${kind}:${at}`, removeOnComplete: true, removeOnFail: 100 });
  }
}

/** The canonical worker shape: tenantId in the payload, runWithTenant first. */
@Processor(HOLD_TIMER_QUEUE)
export class HoldTimerProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly events: SeatEvents,
    private readonly locks: RedisLocks,
    private readonly breaker: RedisHealthBreaker,
  ) {
    super();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(job: Job<HoldTimerJob>): Promise<string> {
    const { tenantId, screeningId, holdId, seatIds, expiresAt, kind } = job.data;
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason: 'hold timer' }), async () => {
      // Still the same hold, still held, and not extended past this timer?
      const live = await this.tenantDb.withTenantScope(() =>
        db()
          .select({ seatId: seatLock.seatId, expiresAt: seatLock.expiresAt })
          .from(seatLock)
          .where(and(eq(seatLock.holdId, holdId), eq(seatLock.status, 'held'))),
      );
      if (!live.length) return 'gone'; // released or sold meanwhile: nothing to announce
      const current = live[0]!.expiresAt!;
      if (current.getTime() > Date.parse(expiresAt)) return 'extended';
      if (kind === 'expiring') {
        this.events.toHold(holdId, 'hold:expiring', current);
        return 'warned';
      }
      this.events.toHold(holdId, 'hold:expired', current);
      const v = await this.breaker.attempt(() => this.locks.bumpVersion(tenantId, screeningId));
      this.events.publish(tenantId, screeningId, 'seats:released', seatIds, v.ok ? v.value : null);
      return 'expired';
    });
  }
}

