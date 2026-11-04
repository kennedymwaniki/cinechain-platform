import { Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { seatLock } from '../db/schema/inventory';
import { RedisFactory } from '../redis/redis.module';
import { toSystemContext } from '../tenancy/system-context';
import { db, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantData } from './tenant-data';

export const LIFECYCLE_QUEUE = 'tenant.lifecycle';

export type LifecycleAction = 'release-holds' | 'export' | 'delete' | 'counts';
export interface LifecycleJob {
  tenantId: string;
  action: LifecycleAction;
}

/** Deletes keys matching `pattern` with SCAN (never KEYS: it would block Redis for everyone). */
export async function deleteByPattern(redis: ReturnType<RedisFactory['get']>, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

/**
 * The application plane's half of the tenant lifecycle (step 27). The
 * control plane orchestrates; this does what only cinechain_app may do —
 * touch tenant rows — inside the tenant's own scope. The canonical worker
 * shape: tenantId in the payload, runWithTenant before anything else.
 */
@Processor(LIFECYCLE_QUEUE)
export class LifecycleProcessor extends WorkerHost implements BeforeApplicationShutdown {
  private readonly log = new Logger(LifecycleProcessor.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly data: TenantData,
    private readonly redis: RedisFactory,
  ) {
    super();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(job: Job<LifecycleJob>): Promise<unknown> {
    const { tenantId, action } = job.data;
    const ctx = toSystemContext({ tenantId }, { kind: 'system', reason: `tenant ${action}` });
    return runWithTenant(ctx, async () => {
      switch (action) {
        case 'release-holds':
          return this.releaseHolds(tenantId);
        case 'export':
          return { manifest: await this.data.export(ctx) };
        case 'delete':
          return { tables: await this.data.delete(ctx) };
        case 'counts':
          return { counts: await this.data.counts(ctx) };
      }
    });
  }

  /**
   * Suspension and offboarding release LIVE holds: those seats go back to no
   * one (sales are closed), and nobody is left believing they hold a seat.
   * Confirmed sales are untouched: a customer who paid still gets in.
   */
  private async releaseHolds(tenantId: string) {
    const released = await this.tenantDb.withTenantScope(async () =>
      (await db().delete(seatLock).where(and(eq(seatLock.status, 'held'))).returning({ seatId: seatLock.seatId })).length,
    );
    const r = this.redis.get('lifecycle', { enableOfflineQueue: true });
    const keys =
      (await deleteByPattern(r, `lock:{t:${tenantId}:*`)) + (await deleteByPattern(r, `hold:{t:${tenantId}:*`)) + (await deleteByPattern(r, `seatmap:{t:${tenantId}:*`));
    this.log.log(`released ${released} live hold row(s), ${keys} Redis key(s)`);
    return { released_rows: released, released_keys: keys };
  }
}
