import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { RedisFactory } from '../redis/redis.module';

export const USAGE_FIELDS = ['requests', 'hold_seconds', 'bookings', 'tickets'] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];
export const FLUSH_EVERY_MS = 5_000;

/** UTC calendar month: the billing period. */
export const periodOf = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * TENANT-PREFIXED (one hash tag per tenant), so `MEMORY USAGE` and `SCAN
 * usage:{t:<id>}:*` measure one tenant's footprint for cost attribution.
 */
export const usageKey = (tenantId: string, period: string) => `usage:{t:${tenantId}}:${period}`;

/**
 * Counts consumption per tenant (PRD §14.1 "Consumption"). Increments are
 * buffered in memory and flushed to Redis every few seconds as HINCRBY — one
 * pipeline, not one round trip per request. A failed flush is put back and
 * retried; it never fails the request that produced it. The aggregator (the
 * second @CrossTenantJob, in the control plane) folds these into Postgres.
 */
@Injectable()
export class UsageRecorder implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(UsageRecorder.name);
  private buffer = new Map<string, Map<UsageField, number>>(); // usage key → field → n
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly redis: RedisFactory) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  add(tenantId: string, field: UsageField, n = 1): void {
    if (!tenantId || n <= 0 || !Number.isSafeInteger(n)) return;
    const key = usageKey(tenantId, periodOf());
    const fields = this.buffer.get(key) ?? new Map<UsageField, number>();
    fields.set(field, (fields.get(field) ?? 0) + n);
    this.buffer.set(key, fields);
  }

  /**
   * One MULTI per tenant key: all of a key's fields land, or none do. (A plain
   * pipeline can half-apply, and re-buffering it would then double-count.)
   * Each key is one hash slot, so this is cluster-safe. Only failed keys are
   * put back for the next flush.
   */
  async flush(): Promise<void> {
    if (!this.buffer.size) return;
    const pending = this.buffer;
    this.buffer = new Map();
    const client = this.redis.get('metering', { enableOfflineQueue: true });
    for (const [key, fields] of pending) {
      try {
        const tx = client.multi();
        for (const [f, n] of fields) tx.hincrby(key, f, n);
        const results = await tx.exec();
        if (!results || results.some(([err]) => err)) throw new Error('transaction aborted');
      } catch (e) {
        const cur = this.buffer.get(key) ?? new Map<UsageField, number>();
        for (const [f, n] of fields) cur.set(f, (cur.get(f) ?? 0) + n);
        this.buffer.set(key, cur);
        this.log.warn(`usage flush failed, will retry: ${(e as Error).message}`);
      }
    }
  }
}
