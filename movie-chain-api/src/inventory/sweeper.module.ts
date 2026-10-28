import { Module } from '@nestjs/common';
import { registerProducerQueue } from '../queue/queue.module';
import { SWEEPER_DB_PROVIDER } from '../tenancy/sweeper-db.provider';
import { SWEEPER_QUEUE, SweeperProcessor } from './sweeper.processor';

/** Separate from InventoryModule so the HTTP paths never depend on BullMQ. */
@Module({
  imports: [registerProducerQueue(SWEEPER_QUEUE)],
  providers: [SWEEPER_DB_PROVIDER, SweeperProcessor],
  exports: [SweeperProcessor],
})
export class SweeperModule {}
