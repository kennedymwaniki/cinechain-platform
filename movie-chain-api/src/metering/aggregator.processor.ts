import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { CrossTenantJob } from '../common/elevated/cross-tenant-job';
import { RedisFactory } from '../redis/redis.module';
import { StorageService } from '../storage/storage.service';
import { MeteringRepository, type UsageRow } from './metering.repository';
import { periodOf, USAGE_FIELDS } from './usage.recorder';

export const METERING_QUEUE = 'control.metering';
export const AGGREGATE_EVERY_MS = 5 * 60_000;
/** Folded counters stay in Redis this long after their period, then expire. */
const KEEP_FOLDED_S = 90 * 24 * 3600;
const KEY_RE = /^usage:\{t:([0-9a-f-]{36})\}:(\d{4}-\d{2})$/;

/**
 * Folds every tenant's usage counters (Redis) and object-storage footprint
 * (MinIO, per t/<tenant_id>/ prefix) into platform.metering_usage.
 *
 * THE SECOND AND FINAL @CrossTenantJob. It runs in the CONTROL PLANE, as
 * cinechain_control — a role with no grant on booking, ticket or payment — so
 * it cannot read a booking even by mistake: it counts what the application
 * plane already counted. The values are absolute (Redis holds the period's
 * running total), so a repeated or overlapping run is harmless.
 */
@Injectable()
export class MeteringAggregator {
  private readonly log = new Logger(MeteringAggregator.name);

  constructor(
    private readonly redis: RedisFactory,
    private readonly storage: StorageService,
    private readonly repo: MeteringRepository,
  ) {}

  async aggregate(now = new Date()): Promise<{ tenants: number; rows: number }> {
    const client = this.redis.get('metering', { enableOfflineQueue: true });
    const rows = new Map<string, UsageRow>();
    const row = (tenantId: string, period: string) => {
      const k = `${tenantId}|${period}`;
      if (!rows.has(k)) rows.set(k, { tenantId, period, requests: 0, holdSeconds: 0, bookings: 0, tickets: 0, storageBytes: null });
      return rows.get(k)!;
    };

    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', 'usage:{t:*', 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        const m = KEY_RE.exec(key);
        if (!m) continue;
        const h = await client.hgetall(key);
        const r = row(m[1]!, m[2]!);
        for (const f of USAGE_FIELDS) {
          const n = Number(h[f] ?? 0);
          if (f === 'requests') r.requests = n;
          else if (f === 'hold_seconds') r.holdSeconds = n;
          else if (f === 'bookings') r.bookings = n;
          else r.tickets = n;
        }
        if (m[2] !== periodOf(now)) await client.expire(key, KEEP_FOLDED_S, 'NX');
      }
    } while (cursor !== '0');

    // Storage is a level, not a flow: measured now, recorded on the current period.
    const tenants = await this.repo.tenantIds();
    const period = periodOf(now);
    for (const tenantId of tenants) row(tenantId, period).storageBytes = await this.storage.prefixBytes(tenantId).catch((e: Error) => {
      this.log.warn(`could not measure storage: ${e.message}`);
      return null;
    });

    const known = new Set(tenants);
    const out = [...rows.values()].filter((r) => known.has(r.tenantId)); // a key for a deleted tenant is ignored
    await this.repo.upsert(out);
    return { tenants: tenants.length, rows: out.length };
  }
}

@CrossTenantJob('folds every tenant’s usage counters and storage footprint into platform.metering_usage; control plane, no booking grants (ELEVATED_JOBS.md)')
@Processor(METERING_QUEUE)
export class MeteringAggregatorProcessor extends WorkerHost implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(MeteringAggregatorProcessor.name);

  constructor(
    @InjectQueue(METERING_QUEUE) private readonly queue: Queue,
    private readonly redis: RedisFactory,
    private readonly aggregator: MeteringAggregator,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('aggregate-usage', { every: AGGREGATE_EVERY_MS }, { name: 'aggregate' }).catch((e: Error) => {
      this.log.warn(`could not schedule metering: ${e.message}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  /** One run per tick, cluster-wide (the same per-tick claim as the sweeper). */
  async process(job: Job): Promise<unknown> {
    const claimed = await this.redis
      .get('metering', { enableOfflineQueue: true })
      .set(`metering:tick:${job.id ?? randomUUID()}`, '1', 'PX', 30 * 60_000, 'NX')
      .catch(() => 'OK' as const);
    if (claimed !== 'OK') return 'already ran';
    return this.aggregator.aggregate();
  }
}
