import { Module } from '@nestjs/common';
import { registerProducerQueue } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { EXPORT_QUEUE, ExportController, ExportProcessor, ExportService } from './export.processor';
import { ReportingModule } from './reporting.module';

/** The asynchronous half (FR-66). Separate so the report routes never depend on BullMQ. */
@Module({
  imports: [ReportingModule, StorageModule, registerProducerQueue(EXPORT_QUEUE)],
  controllers: [ExportController],
  providers: [ExportService, ExportProcessor],
})
export class ExportModule {}
