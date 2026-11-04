import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { registerProducerQueue } from '../queue/queue.module';
import { GuestLinkFanout, LINK_GUEST_QUEUE, LinkGuestProcessor } from './guest-link';
import { TenantJobGate } from '../lifecycle/tenant-job-gate';

/** FR-77's background half. Separate so the HTTP paths never depend on BullMQ. */
@Module({
  imports: [IdentityModule, registerProducerQueue(LINK_GUEST_QUEUE)],
  providers: [GuestLinkFanout, LinkGuestProcessor, TenantJobGate],
  exports: [GuestLinkFanout],
})
export class GuestLinkModule {}
