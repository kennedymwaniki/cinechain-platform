import { Injectable } from '@nestjs/common';
import { holdRoom, SeatmapGateway, screeningRoom } from './seatmap.gateway';

export type PublicSeatEvent = 'seats:taken' | 'seats:released' | 'screening:updated' | 'screening:cancelled';
export type HoldEvent = 'hold:expiring' | 'hold:expired' | 'hold:extended';

/**
 * The only way anything is broadcast. Public payloads are exactly
 * `{ screeningId, seatIds, version, at }` — no hold id, no tenant id. Hold and
 * sale BOTH emit `seats:taken`: separate events would let a client diff them
 * and recover the held/sold distinction the seat map masks (§7.6).
 */
@Injectable()
export class SeatEvents {
  constructor(private readonly gateway: SeatmapGateway) {}

  publish(tenantId: string, screeningId: string, event: PublicSeatEvent, seatIds: string[], version: number | null): void {
    this.gateway.server?.to(screeningRoom(tenantId, screeningId)).emit(event, { screeningId, seatIds, version, at: new Date().toISOString() });
  }

  /** Countdowns render from the SERVER's expires_at, never a local timer. */
  toHold(holdId: string, event: HoldEvent, expiresAt: Date | null): void {
    this.gateway.server?.to(holdRoom(holdId)).emit(event, { holdId, expires_at: expiresAt?.toISOString() ?? null, at: new Date().toISOString() });
  }
}
