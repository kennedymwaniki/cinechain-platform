import { Module, type OnModuleInit } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { OutboxRelay } from '../booking/outbox.relay';
import { UsageRecorder } from './usage.recorder';

/** Bookings and tickets are counted from the OUTBOX: only sales that committed. */
@Module({ imports: [BookingModule] })
export class BookingMeteringModule implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelay,
    private readonly usage: UsageRecorder,
  ) {}

  onModuleInit(): void {
    this.relay.on('booking.confirmed', async (tenantId, p) => {
      this.usage.add(tenantId, 'bookings', 1);
      this.usage.add(tenantId, 'tickets', Number(p.seats ?? 0));
    });
  }
}
