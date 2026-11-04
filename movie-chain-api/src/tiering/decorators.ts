import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_TENANT_FROM = 'cinechain:rate-limit-tenant-from';
export const SKIP_RATE_LIMIT = 'cinechain:skip-rate-limit';

/**
 * Where a PUBLIC route's tenant comes from, for rate limiting — by the same
 * verified means the handler itself uses. Never an unverified claim: a forged
 * token naming another chain would otherwise spend that chain's quota.
 *   screening          → :id, through the resolve_published_screening door
 *   hold_token         → the signed hold token (body `hold_token`, or the Hold-Token header)
 *   booking_token      → the signed booking link (Booking-Token header)
 * Staff routes need nothing: their tenant is the verified JWT's.
 */
export type TenantSource = 'screening' | 'hold_token' | 'booking_token';
export const RateLimitTenantFrom = (source: TenantSource) => SetMetadata(RATE_LIMIT_TENANT_FROM, source);

/** Health checks, scrapes and provider webhooks: not customer traffic. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
