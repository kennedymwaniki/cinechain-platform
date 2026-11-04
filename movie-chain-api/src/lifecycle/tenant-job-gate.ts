import { Injectable } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { TenantRegistry } from '../tenancy/tenant-registry.service';

export const PAUSED_RETRY_MS = 60_000;

/**
 * Pausing a tenant's background work (step 27). BullMQ queues are shared by
 * every tenant, so a tenant is paused per JOB, at the start of the work:
 *   suspended            → the job is put back, delayed, and runs on reactivation;
 *   offboarding/deleted  → the job is dropped (its data is going or gone).
 * Use it for TENANT-INITIATED work (exports, guest linking). Obligations to
 * customers — ticket notifications, refunds — are NOT gated: a suspended
 * chain still owes its customers their tickets and their money.
 */
@Injectable()
export class TenantJobGate {
  constructor(private readonly registry: TenantRegistry) {}

  /** Returns 'run' or 'drop'; for a suspended tenant it reschedules the job and throws DelayedError (BullMQ's signal). */
  async check(job: Job, token: string | undefined, tenantId: string): Promise<'run' | 'drop'> {
    const t = await this.registry.byId(tenantId);
    if (!t || t.status === 'offboarding' || t.status === 'deleted') return 'drop';
    if (t.status === 'suspended') {
      await job.moveToDelayed(Date.now() + PAUSED_RETRY_MS, token);
      throw new DelayedError();
    }
    return 'run';
  }
}
