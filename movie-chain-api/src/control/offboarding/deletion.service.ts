import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { deleteByPattern } from '../../lifecycle/lifecycle.processor';
import { connectionFrom, QUEUE_PREFIX } from '../../queue/queue.module';
import { RedisFactory } from '../../redis/redis.module';
import { StorageService } from '../../storage/storage.service';

/**
 * The application-plane queues whose jobs carry `tenantId` in their payload
 * (convention 10). An offboarded tenant's waiting or delayed jobs are removed.
 */
export const TENANT_QUEUES = ['notification', 'identity.link-guest', 'realtime.hold-timers', 'booking.reconcile', 'reporting.export', 'tenant.lifecycle'] as const;
// BullMQ 6 has no 'paused' job state: a paused queue's jobs are still 'waiting'.
const PENDING = ['waiting', 'delayed', 'prioritized', 'waiting-children'] as const;

/**
 * The control plane's half of deletion: everything that is NOT a tenant
 * table — Redis keys (every key carries the tenant in its hash tag), queued
 * jobs, and objects under t/<tenant_id>/. Each step reports what it removed
 * AND re-counts what remains.
 */
@Injectable()
export class DeletionService {
  constructor(
    private readonly redis: RedisFactory,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Every key with the tenant inside a hash tag: locks, holds, seat maps, versions, usage, rate limits, report caches. */
  private pattern(tenantId: string) {
    return `*{t:${tenantId}*`;
  }

  async redisKeys(tenantId: string): Promise<{ deleted: number; remaining: number }> {
    const r = this.redis.get('offboarding', { enableOfflineQueue: true });
    const deleted = await deleteByPattern(r, this.pattern(tenantId));
    let remaining = 0;
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', this.pattern(tenantId), 'COUNT', 500);
      cursor = next;
      remaining += keys.length;
    } while (cursor !== '0');
    return { deleted, remaining };
  }

  async queuedJobs(tenantId: string, keepJobIds: string[] = []): Promise<{ removed: number; remaining: number }> {
    let removed = 0;
    let remaining = 0;
    for (const name of TENANT_QUEUES) {
      const q = new Queue(name, { connection: connectionFrom(this.cfg.redis.url), prefix: QUEUE_PREFIX });
      try {
        for (const job of await q.getJobs([...PENDING]))
          if ((job.data as { tenantId?: string } | undefined)?.tenantId === tenantId && !keepJobIds.includes(job.id ?? '')) {
            await job.remove();
            removed++;
          }
        remaining += (await q.getJobs([...PENDING])).filter((j) => (j.data as { tenantId?: string } | undefined)?.tenantId === tenantId && !keepJobIds.includes(j.id ?? '')).length;
      } finally {
        await q.close();
      }
    }
    return { removed, remaining };
  }

  /** Every object under t/<tenant_id>/ EXCEPT the export, which is kept for its download window. */
  async objects(tenantId: string): Promise<{ deleted: number; remaining_outside_export: number; retained_export: number }> {
    const exportPrefix = StorageService.tenantKey(tenantId, ['offboarding', 'export', 'x']).slice(0, -1);
    const keys = await this.storage.listTenantKeys(tenantId);
    const deleted = await this.storage.deleteTenantKeys(tenantId, keys.filter((k) => !k.startsWith(exportPrefix)));
    const after = await this.storage.listTenantKeys(tenantId);
    return {
      deleted,
      remaining_outside_export: after.filter((k) => !k.startsWith(exportPrefix)).length,
      retained_export: after.filter((k) => k.startsWith(exportPrefix)).length,
    };
  }
}
