import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Inject, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { CrossTenantJob } from '../common/elevated/cross-tenant-job';
import { Metrics } from '../metrics/metrics.service';
import { RedisHealthBreaker } from '../redis/redis-health.breaker';
import { RedisFactory } from '../redis/redis.module';
import { SweeperDb } from '../tenancy/sweeper-db.provider';

export const SWEEPER_QUEUE = 'inventory.sweeper';
export const SWEEP_EVERY_MS = 30_000;
export const SWEEP_EVERY_MS_REDIS_DOWN = 10_000;
/** Load-bearing: the durable row must outlive its Redis key, so a hold mid-conversion is never swept. */
export const SWEEP_GRACE_SECONDS = 30;
export const SWEEP_BATCH = 5000;

/**
 * Keeps the durable record honest. It is NOT the release mechanism: Redis TTL
 * frees a seat the instant its hold expires, and the hold INSERT takes over
 * an expired row directly. This only deletes rows long dead.
 *
 * The first of exactly two jobs that run without a tenant scope.
 */
@CrossTenantJob('expired holds exist in every tenant at once; one pass reconciles them all (ELEVATED_JOBS.md)')
@Processor(SWEEPER_QUEUE)
export class SweeperProcessor extends WorkerHost implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(SweeperProcessor.name);

  constructor(
    @InjectQueue(SWEEPER_QUEUE) private readonly queue: Queue,
    @Optional() @Inject(SweeperDb) private readonly sweeper: SweeperDb | null,
    private readonly redis: RedisFactory,
    private readonly breaker: RedisHealthBreaker,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.sweeper) {
      this.log.warn('SWEEPER_DATABASE_URL is not set: the hold sweeper does not run in this process');
      return;
    }
    await this.sweeper.assertNarrowRole();
    await this.schedule(SWEEP_EVERY_MS);
    this.breaker.onChange((open) => void this.schedule(open ? SWEEP_EVERY_MS_REDIS_DOWN : SWEEP_EVERY_MS));
  }

  /**
   * A sweep is idempotent, so there is nothing to drain: close the worker
   * without waiting. BullMQ's graceful close waits for Redis, and a process
   * that cannot shut down while Redis is down cannot be restarted to recover.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  private async schedule(every: number): Promise<void> {
    // Idempotent by id: every instance upserts the SAME scheduler, so one job per tick.
    await this.queue.upsertJobScheduler('sweep-expired-holds', { every }, { name: 'sweep' }).catch((e: Error) => {
      this.log.warn(`could not (re)schedule the sweeper: ${e.message}`);
    });
  }

  async process(job: Job): Promise<void> {
    // A scheduler job's id is `repeat:<scheduler>:<tick time>`: the same on every instance.
    await this.tick(job.id ?? randomUUID());
  }

  /**
   * One sweep per tick, cluster-wide: the first instance to claim the tick's
   * key runs it and the key is never released early, so a duplicate delivery
   * of the same tick (another instance, a retry) is a no-op. If Redis itself
   * is unreachable the sweep runs anyway: it is idempotent and SKIP LOCKED,
   * so two concurrent sweeps cannot conflict.
   */
  async tick(tickId: string = randomUUID()): Promise<{ ran: boolean; swept: number }> {
    if (!this.sweeper) return { ran: false, swept: 0 };
    // Its own client, queueing until connected: a command sent before the
    // connection is up must wait, not fail (a failure is read as "Redis down").
    const lockClient = this.redis.get('sweeper', { enableOfflineQueue: true });
    const claimed = await lockClient.set(`sweeper:tick:${tickId}`, '1', 'PX', 5 * 60_000, 'NX').catch(() => 'OK' as const);
    if (claimed !== 'OK') return { ran: false, swept: 0 };

    const rows = await this.sweeper.sweepExpiredHolds(SWEEP_GRACE_SECONDS, SWEEP_BATCH);
    const now = Date.now();
    const byTenant = new Map<string, { n: number; lagS: number }>();
    for (const r of rows) {
      const t = byTenant.get(r.tenant_id) ?? { n: 0, lagS: 0 };
      t.n++;
      t.lagS = Math.max(t.lagS, Math.round((now - new Date(r.expires_at).getTime()) / 1000));
      byTenant.set(r.tenant_id, t);
    }
    for (const [tenant, t] of byTenant) {
      this.metrics.inc('sweeper.reclaimed_total', { tenant }, t.n);
      this.metrics.set('sweeper.lag', { tenant }, t.lagS);
    }
    return { ran: true, swept: rows.length };
  }
}
