import { Module } from '@nestjs/common';
import { registerProducerQueue } from '../queue/queue.module';
import { BookingModule } from './booking.module';
import { RECONCILE_QUEUE, ReconciliationProcessor } from './reconciliation.processor';

/** The scheduled half of reconciliation. Separate so the HTTP paths never depend on BullMQ. */
@Module({
  imports: [BookingModule, registerProducerQueue(RECONCILE_QUEUE)],
  providers: [ReconciliationProcessor],
})
export class ReconciliationModule {}
