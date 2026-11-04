import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { RedisHealthBreaker } from '../redis/redis-health.breaker';
import { RedisFactory } from '../redis/redis.module';

const LUA = readFileSync(join(__dirname, 'scripts', 'sliding-window.lua'), 'utf8');
export const WINDOW_MS = 1_000;

type SlidingWindow = Redis & { slidingWindow(key: string, limit: number, windowMs: number): Promise<[number, number, number]> };

export type Verdict = { allowed: true } | { allowed: false; retryAfterMs: number; observed: number };

/**
 * A distributed sliding window per subject (`t:<tenant>` or `ip:<addr>`),
 * shared by every API instance through Redis. One EVALSHA per request
 * (ioredis defineCommand loads the script and falls back on NOSCRIPT).
 */
@Injectable()
export class TenantRateLimiter implements OnModuleInit {
  private readonly log = new Logger(TenantRateLimiter.name);
  /**
   * subject → refused until (ms). Once Redis has said "over the limit" for this
   * window, this instance refuses the rest of the window by itself: during a
   * flood the refusals — most of the traffic — cost no network round trip.
   */
  private readonly deniedUntil = new Map<string, number>();

  constructor(
    private readonly redis: RedisFactory,
    private readonly breaker: RedisHealthBreaker,
  ) {}

  /**
   * Connect before serving. The client refuses commands while it is still
   * connecting (no offline queue: a down Redis must fail fast), and an early
   * refusal reads as "Redis down" — which fails OPEN, i.e. no limit at all.
   */
  async onModuleInit(): Promise<void> {
    const c = this.client();
    if (c.status === 'ready') return;
    await new Promise<void>((ok) => {
      const t = setTimeout(() => {
        this.log.warn('redis not ready within 3s: rate limits fail open until it is');
        ok();
      }, 3000);
      c.once('ready', () => (clearTimeout(t), ok()));
    });
  }

  private client(): SlidingWindow {
    const c = this.redis.get('ratelimit') as SlidingWindow;
    if (!c.slidingWindow) c.defineCommand('slidingWindow', { numberOfKeys: 1, lua: LUA });
    return c;
  }

  /** Fails OPEN when Redis is unavailable: a limiter must never be why a booking fails. */
  /** How long this instance has ALREADY refused `subject` for (0 = not refused). No I/O. */
  refusedFor(subject: string): number {
    const until = this.deniedUntil.get(subject);
    return until === undefined ? 0 : Math.max(0, until - Date.now());
  }

  async hit(subject: string, perSecond: number): Promise<Verdict> {
    const until = this.deniedUntil.get(subject);
    const now = Date.now();
    if (until !== undefined) {
      if (now < until) return { allowed: false, retryAfterMs: until - now, observed: perSecond };
      this.deniedUntil.delete(subject);
    }
    const r = await this.breaker.attempt(() => this.client().slidingWindow(`rl:{${subject}}`, perSecond, WINDOW_MS));
    if (!r.ok) return { allowed: true };
    const [ok, observed, retry] = r.value;
    if (ok === 1) return { allowed: true };
    if (this.deniedUntil.size > 10_000) this.deniedUntil.clear();
    this.deniedUntil.set(subject, now + Math.max(1, retry));
    return { allowed: false, retryAfterMs: Math.max(1, retry), observed };
  }
}
