import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Metrics } from '../observability/metrics.module';
import { tenantLimitBody } from './rate-limit.guard';
import { ScreeningTenants } from './screening-tenants';
import { TierConfig } from './tier-config.service';
import { TenantRateLimiter } from './tenant-rate-limiter';

const SCREENING_PATH = /\/screenings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:seatmap|holds)\b/i;

/**
 * During a flood, most of a noisy tenant's requests are refusals — and each
 * one paid for the whole Nest pipeline before the guard said no. This
 * short-circuits ONLY a request whose tenant the guard has ALREADY refused for
 * the current window (the limiter's local deny cache), recognised from the
 * screening id in the path. It decides nothing: no Redis call, no new
 * attribution. Anything it does not recognise goes on to the guard.
 * (The edge's limit_req is the primary protection; this is the same idea
 * inside the process.)
 */
@Injectable()
export class EarlyRefusalMiddleware implements NestMiddleware {
  constructor(
    private readonly screenings: ScreeningTenants,
    private readonly limiter: TenantRateLimiter,
    private readonly tiers: TierConfig,
    private readonly metrics: Metrics,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const m = SCREENING_PATH.exec(req.originalUrl);
    const tenantId = m ? this.screenings.get(m[1]!.toLowerCase()) : null;
    const retryAfterMs = tenantId ? this.limiter.refusedFor(`t:${tenantId}`) : 0;
    if (!tenantId || retryAfterMs <= 0) return next();
    void this.tiers.limitsFor(tenantId).then((limits) => {
      if (!limits) return next();
      this.metrics.inc('rate_limited_total', { tenant: tenantId, scope: 'tenant' });
      const body = tenantLimitBody(limits, retryAfterMs);
      res.status(429).setHeader('Retry-After', String(body.retry_after_s));
      res.json(body);
    }, next);
  }
}
