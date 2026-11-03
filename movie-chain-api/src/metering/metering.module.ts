import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { InventoryEvents } from '../inventory/inventory-events';
import { InventoryModule } from '../inventory/inventory.module';
import { UsageRecorder } from './usage.recorder';

/**
 * The APPLICATION plane's half of metering: count. Requests are counted by
 * the request middleware (tenant attached by the tenancy layer); hold-seconds
 * from inventory events; bookings and tickets from the booking outbox
 * (BookingMeteringModule), i.e. only once they have committed.
 */
@Global()
@Module({ imports: [InventoryModule], providers: [UsageRecorder], exports: [UsageRecorder] })
export class MeteringModule implements OnModuleInit {
  constructor(
    private readonly usage: UsageRecorder,
    private readonly inventory: InventoryEvents,
  ) {}

  onModuleInit(): void {
    this.inventory.on((e) => {
      // Seat-seconds reserved: what a hold costs in inventory, whatever happens to it next.
      if (e.kind === 'hold.placed') this.usage.add(e.tenantId, 'hold_seconds', e.seatIds.length * Math.max(0, Math.round((e.expiresAt.getTime() - Date.now()) / 1000)));
      if (e.kind === 'hold.extended') this.usage.add(e.tenantId, 'hold_seconds', e.seatIds.length * 120);
    });
  }
}
