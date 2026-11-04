import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { RateLimitedError } from '../common/errors/domain-errors';
import { BookingTokenService } from '../booking/booking-token.service';
import { HoldTokenService } from '../inventory/hold-token.service';
import { Metrics } from '../observability/metrics.module';
import { Doors } from '../tenancy/doors';
import type { TenantScopedRequest } from '../tenancy/tenant.interceptor';
import { UUID_RE } from '../tenancy/tenant-db.provider';
import { RATE_LIMIT_TENANT_FROM, SKIP_RATE_LIMIT, type TenantSource } from './decorators';
import { ScreeningTenants } from './screening-tenants';
import { type TenantLimits, TierConfig } from './tier-config.service';
import { TenantRateLimiter, WINDOW_MS } from './tenant-rate-limiter';


/**
 * Per-tenant rate limits (step 25). Runs AFTER the access guard, so a staff
 * request already has its tenant from the verified JWT; a public route names
 * how its tenant is resolved (@RateLimitTenantFrom). A route with no tenant
 * (sign-in, discovery) is limited per client address instead.
 *
 * A refusal is a 429 that says WHICH limit was hit and when to retry: an
 * unexplained error is a support ticket; the same limit, explained, is an
 * upgrade conversation.
 */
/** The refusal a tenant sees: the same body from the guard and from the early-refusal middleware. */
export function tenantLimitBody(limits: TenantLimits, retryAfterMs: number) {
  return {
    error: 'rate_limited' as const,
    message: `This cinema chain's ${limits.tierName} plan allows ${limits.rateLimitRps} requests per second; try again shortly`,
    retry_after_s: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    limit: { scope: 'tenant', tier: limits.tier, requests_per_second: limits.rateLimitRps, window_s: WINDOW_MS / 1000 },
  };
}

@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: TenantRateLimiter,
    private readonly tiers: TierConfig,
    private readonly doors: Doors,
    private readonly holdTokens: HoldTokenService,
    private readonly bookingTokens: BookingTokenService,
    private readonly metrics: Metrics,
    private readonly screenings: ScreeningTenants,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, targets)) return true;
    const req = context.switchToHttp().getRequest<Request & TenantScopedRequest>();

    const source = this.reflector.getAllAndOverride<TenantSource | undefined>(RATE_LIMIT_TENANT_FROM, targets);
    const tenantId = req.tenantContext?.tenantId ?? (source ? await this.attribute(req, source) : null);

    if (tenantId) {
      const limits = await this.tiers.limitsFor(tenantId);
      if (!limits) return true; // unknown tenant: the handler answers 404 on its own
      const v = await this.limiter.hit(`t:${tenantId}`, limits.rateLimitRps);
      if (v.allowed) return true;
      this.metrics.inc('rate_limited_total', { tenant: tenantId, scope: 'tenant' });
      const body = tenantLimitBody(limits, v.retryAfterMs);
      throw new RateLimitedError(body.retry_after_s, { message: body.message, limit: body.limit });
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const v = await this.limiter.hit(`ip:${ip}`, this.cfg.rateLimit.perAddressRps);
    if (v.allowed) return true;
    this.metrics.inc('rate_limited_total', { tenant: 'none', scope: 'address' });
    throw new RateLimitedError(Math.ceil(v.retryAfterMs / 1000), {
      message: `At most ${this.cfg.rateLimit.perAddressRps} requests per second from one address; try again shortly`,
      limit: { scope: 'address', requests_per_second: this.cfg.rateLimit.perAddressRps, window_s: WINDOW_MS / 1000 },
    });
  }

  /** The SAME verified sources the handlers use. An invalid token attributes nothing (the handler 401s). */
  private async attribute(req: Request, source: TenantSource): Promise<string | null> {
    try {
      if (source === 'screening') {
        const id = req.params?.id;
        if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
        const cached = this.screenings.get(id.toLowerCase());
        if (cached) return cached;
        const owner = await this.doors.resolvePublishedScreening(id);
        if (!owner) return null;
        this.screenings.set(id.toLowerCase(), owner.tenantId);
        return owner.tenantId;
      }
      if (source === 'hold_token') {
        const raw = (req.body as { hold_token?: unknown } | undefined)?.hold_token ?? req.header('hold-token');
        return typeof raw === 'string' ? (await this.holdTokens.verify(raw, {})).tenant_id : null;
      }
      const raw = req.header('booking-token');
      return raw ? (await this.bookingTokens.verify(raw)).tenant_id : null;
    } catch {
      return null;
    }
  }
}
