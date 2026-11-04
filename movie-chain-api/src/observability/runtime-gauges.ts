import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { connectionFrom, QUEUE_PREFIX } from '../queue/queue.module';
import { ReportingDb } from '../tenancy/reporting-db.provider';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { Metrics } from './metrics.module';

/** The application plane's job queues (every one carries tenantId in its payload). */
export const OBSERVED_QUEUES = ['notification', 'identity.link-guest', 'realtime.hold-timers', 'booking.reconcile', 'reporting.export', 'tenant.lifecycle'] as const;
const JOB_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;

/**
 * Gauges read at scrape time: the database pools (booking vs reporting, so
 * a starving report pool is visible apart from the sale path) and the BullMQ
 * queue depths. Counts only: nothing here carries tenant data.
 */
@Injectable()
export class RuntimeGauges implements OnModuleInit, OnApplicationShutdown {
  private readonly queues: Queue[] = [];

  constructor(
    private readonly metrics: Metrics,
    private readonly tenantDb: TenantDb,
    private readonly moduleRef: ModuleRef,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    const pools: Array<[string, TenantDb]> = [['booking', this.tenantDb]];
    try {
      pools.push(['reporting', this.moduleRef.get(ReportingDb, { strict: false })]);
    } catch {
      /* no reporting pool in this process */
    }
    this.metrics.sampled('db.pool_connections', 'Database pool connections by state', ['pool', 'state'], () =>
      pools.flatMap(([pool, db]) => {
        const s = db.poolStats();
        return [
          [{ pool, state: 'in_use' }, s.size - s.idle],
          [{ pool, state: 'idle' }, s.idle],
          [{ pool, state: 'waiting_clients' }, s.waiting],
        ] as Array<[Record<string, string>, number]>;
      }),
    );

    // Producer-style connections: fail fast while Redis is down, and never block shutdown.
    for (const name of OBSERVED_QUEUES)
      this.queues.push(new Queue(name, { connection: { ...connectionFrom(this.cfg.redis.url), enableOfflineQueue: false }, prefix: QUEUE_PREFIX }));
    this.metrics.sampled('queue.jobs', 'BullMQ jobs by queue and state', ['queue', 'state'], async () => {
      const out: Array<[Record<string, string>, number]> = [];
      for (const q of this.queues) {
        const counts = await q.getJobCounts(...JOB_STATES);
        for (const state of JOB_STATES) out.push([{ queue: q.name, state }, counts[state] ?? 0]);
      }
      return out;
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.queues.map((q) => q.close().catch(() => undefined)));
  }
}
