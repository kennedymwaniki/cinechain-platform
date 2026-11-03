import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { and, count, eq, lt } from 'drizzle-orm';
import { Gauge, Registry } from 'prom-client';
import { onboardingRun } from '../db/schema/control';
import { ControlDb } from '../tenancy/control-db.provider';
import { ControlPublic } from './auth/operator-auth';

export const STUCK_AFTER_MS = 5 * 60_000;

/**
 * The control plane's scrape (it listens on 127.0.0.1 only). Exports the
 * OnboardingStuck input: runs still provisioning after 5 minutes, computed
 * at scrape time so it can never be stale.
 */
@ApiExcludeController()
@Controller('admin/metrics')
export class ControlMetricsController {
  private readonly registry = new Registry();

  constructor(private readonly db: ControlDb) {
    const control = this.db;
    new Gauge({
      name: 'cinechain_onboarding_stuck_runs',
      help: 'Onboarding runs provisioning for more than 5 minutes',
      registers: [this.registry],
      async collect() {
        const [row] = await control.platformTx((tx) =>
          tx
            .select({ n: count() })
            .from(onboardingRun)
            .where(and(eq(onboardingRun.status, 'provisioning'), lt(onboardingRun.updatedAt, new Date(Date.now() - STUCK_AFTER_MS)))),
        );
        this.set(row?.n ?? 0);
      },
    });
  }

  @ControlPublic()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
