import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type OnboardingJob, ONBOARDING_QUEUE, OnboardingService } from './onboarding.service';

/**
 * Control-plane job. It runs on the cinechain_control role, never the app
 * role, and the tenant it provisions is in the payload (generated when the
 * run was created): every tenant-data write happens inside runWithTenant for
 * that id. It is therefore NOT one of the two @CrossTenantJob exceptions.
 */
@Processor(ONBOARDING_QUEUE, { concurrency: 4 })
export class OnboardingProcessor extends WorkerHost {
  constructor(private readonly onboarding: OnboardingService) {
    super();
  }

  async process(job: Job<OnboardingJob>): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    await this.onboarding.execute(job.data, job.attemptsMade + 1 >= attempts);
  }
}
