import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { LIFECYCLE_QUEUE, LifecycleProcessor } from './lifecycle.processor';
import { TenantData } from './tenant-data';

/**
 * The application plane's worker for suspend and offboarding (step 27): it
 * consumes the jobs the control plane enqueues, because only cinechain_app may
 * touch tenant rows — and does so inside the tenant's own RLS scope.
 */
@Module({
  imports: [StorageModule, BullModule.registerQueue({ name: LIFECYCLE_QUEUE })],
  providers: [TenantData, LifecycleProcessor],
  exports: [TenantData],
})
export class LifecycleModule {}
