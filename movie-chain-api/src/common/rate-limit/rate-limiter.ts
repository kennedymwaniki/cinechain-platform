import { Injectable } from '@nestjs/common';
import { RedisFactory } from '../../redis/redis.module';
import { RateLimitedError } from '../errors/domain-errors';

/**
 * Fixed-window counters in Redis, shared by every instance. If Redis is
 * unavailable it falls back to a per-process window rather than letting
 * everything through or refusing everyone. Per-tenant, tier-driven limits
 * arrive in step 25; this guards the two enumeration-sensitive endpoints.
 */
@Injectable()
export class RateLimiter {
  private readonly local = new Map<string, { n: number; until: number }>();

  constructor(private readonly redis: RedisFactory) {}

  /** Throws 429 `rate_limited` once `limit` hits land in one `windowS` window. */
  async consume(bucket: string, limit: number, windowS: number): Promise<void> {
    const window = Math.floor(Date.now() / 1000 / windowS);
    const key = `rl:${bucket}:${window}`;
    let n: number;
    try {
      n = await this.redis.app.incr(key);
      if (n === 1) await this.redis.app.expire(key, windowS + 1);
    } catch {
      const now = Date.now();
      const e = this.local.get(key);
      n = e && e.until > now ? ++e.n : 1;
      if (n === 1) this.local.set(key, { n, until: now + windowS * 1000 });
      if (this.local.size > 10_000) this.local.clear();
    }
    if (n > limit) throw new RateLimitedError(windowS);
  }
}
