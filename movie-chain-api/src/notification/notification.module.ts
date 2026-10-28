import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { registerProducerQueue } from '../queue/queue.module';
import { NOTIFICATION_QUEUE, NotificationEnqueuer, NotificationProcessor } from './notification.processor';
import { LogNotifier, Notifier } from './notifier';

@Module({
  imports: [BookingModule, registerProducerQueue(NOTIFICATION_QUEUE)],
  providers: [LogNotifier, { provide: Notifier, useExisting: LogNotifier }, NotificationEnqueuer, NotificationProcessor],
})
export class NotificationModule {}
