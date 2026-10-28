import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { InventoryModule } from '../inventory/inventory.module';
import { registerProducerQueue } from '../queue/queue.module';
import { HOLD_TIMER_QUEUE, HoldTimerProcessor, HoldTimers } from './hold-timers';
import { OutboxBroadcast } from './outbox-broadcast';
import { RealtimeGateway } from './realtime.gateway';
import { SeatEvents } from './seat-events';
import { SeatmapGateway } from './seatmap.gateway';

@Module({
  imports: [InventoryModule, BookingModule, registerProducerQueue(HOLD_TIMER_QUEUE)],
  providers: [RealtimeGateway, SeatmapGateway, SeatEvents, HoldTimers, HoldTimerProcessor, OutboxBroadcast],
  exports: [SeatEvents],
})
export class RealtimeModule {}
