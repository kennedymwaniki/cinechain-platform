import { Injectable, Logger } from '@nestjs/common';

export type InventoryEvent =
  | { kind: 'hold.placed'; tenantId: string; screeningId: string; holdId: string; seatIds: string[]; expiresAt: Date; version: number | null }
  | { kind: 'hold.released'; tenantId: string; screeningId: string; holdId: string; seatIds: string[]; version: number | null }
  | { kind: 'hold.extended'; tenantId: string; screeningId: string; holdId: string; seatIds: string[]; expiresAt: Date };

/**
 * Inventory announces what COMMITTED; the realtime layer (step 21) listens.
 * A listener failing never fails a hold: the seat map is a view, Postgres
 * is the record, and clients refetch a snapshot when they see a version gap.
 */
@Injectable()
export class InventoryEvents {
  private readonly log = new Logger(InventoryEvents.name);
  private readonly listeners: ((e: InventoryEvent) => Promise<void> | void)[] = [];

  on(fn: (e: InventoryEvent) => Promise<void> | void): void {
    this.listeners.push(fn);
  }

  async emit(e: InventoryEvent): Promise<void> {
    for (const l of this.listeners)
      try {
        await l(e);
      } catch (err) {
        this.log.warn(`${e.kind} listener failed: ${(err as Error).message}`);
      }
  }
}
