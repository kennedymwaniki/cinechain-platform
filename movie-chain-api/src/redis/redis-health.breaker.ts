import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Metrics } from '../observability/metrics.module';

export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 10_000;

export type BreakerResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Three consecutive Redis errors open the breaker for 10 s. While open the
 * hold path skips Redis entirely: the durable INSERT … ON CONFLICT is already
 * a complete hold on its own, Redis only makes the common case faster. The
 * sweeper subscribes to tighten its interval while Redis is out.
 */
@Injectable()
export class RedisHealthBreaker {
  private readonly log = new Logger(RedisHealthBreaker.name);
  private failures = 0;
  private openUntil = 0;
  private readonly listeners: ((open: boolean) => void)[] = [];

  constructor(@Optional() @Inject(Metrics) private readonly metrics: Metrics | null = null) {
    this.metrics?.set('redis_up', {}, 1);
  }

  isOpen(now = Date.now()): boolean {
    if (this.openUntil && now >= this.openUntil) {
      this.openUntil = 0;
      this.failures = 0;
      this.log.log('redis breaker half-open: trying Redis again');
      this.emit(false);
    }
    return this.openUntil > 0;
  }

  onChange(fn: (open: boolean) => void): void {
    this.listeners.push(fn);
  }

  /** Runs `fn` unless the breaker is open. A thrown error counts as a failure and is swallowed. */
  async attempt<T>(fn: () => Promise<T>): Promise<BreakerResult<T>> {
    if (this.isOpen()) return { ok: false };
    try {
      const value = await fn();
      this.failures = 0;
      return { ok: true, value };
    } catch (e) {
      this.recordFailure(e as Error);
      return { ok: false };
    }
  }

  private recordFailure(e: Error): void {
    this.failures++;
    this.log.warn(`redis call failed (${this.failures}/${BREAKER_THRESHOLD}): ${e.message}`);
    if (this.failures >= BREAKER_THRESHOLD && !this.openUntil) {
      this.openUntil = Date.now() + BREAKER_OPEN_MS;
      this.log.warn(`redis breaker OPEN for ${BREAKER_OPEN_MS / 1000}s: holds run on Postgres alone`);
      this.emit(true);
    }
  }

  private emit(open: boolean): void {
    this.metrics?.set('redis_up', {}, open ? 0 : 1);
    for (const l of this.listeners) l(open);
  }
}
