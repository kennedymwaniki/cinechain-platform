import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OutboxRelay } from '../booking/outbox.relay';
import { RedisLocks } from '../inventory/redis-locks';
import { RedisHealthBreaker } from '../redis/redis-health.breaker';
import { SeatEvents } from './seat-events';

/**
 * Sales, cancellations and screening changes reach the seat map from the
 * OUTBOX — i.e. only after they committed. Emitting from inside the
 * transaction would broadcast a sale that later rolled back.
 */
@Injectable()
export class OutboxBroadcast implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelay,
    private readonly events: SeatEvents,
    private readonly locks: RedisLocks,
    private readonly breaker: RedisHealthBreaker,
  ) {}

  onModuleInit(): void {
    const publish = (event: 'seats:taken' | 'seats:released') => async (tenantId: string, p: Record<string, unknown>) => {
      const screeningId = String(p.screeningId);
      const v = await this.breaker.attempt(() => this.locks.bumpVersion(tenantId, screeningId));
      this.events.publish(tenantId, screeningId, event, (p.seatIds as string[]) ?? [], v.ok ? v.value : null);
    };
    this.relay.on('seats:taken', publish('seats:taken'));
    this.relay.on('seats:released', publish('seats:released'));
    this.relay.on('screening:cancelled', async (tenantId, p) => {
      this.events.publish(tenantId, String(p.screeningId), 'screening:cancelled', [], null);
    });
  }
}
