import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Controller, Get, HttpCode, Logger, type OnModuleInit, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { RegistryFanout } from '../../common/elevated/cross-tenant-job';
import { Uuid } from '../../common/validation/uuid.pipe';
import { OffboardWorkflow } from './offboard.workflow';

export const OFFBOARDING_QUEUE = 'control.offboarding';

/** Operators only (control plane, 127.0.0.1). */
@ApiTags('lifecycle')
@ApiBearerAuth()
@Controller('admin/tenants')
export class LifecycleController {
  constructor(private readonly workflow: OffboardWorkflow) {}

  /** FR-6: logins blocked, live holds released, confirmed bookings honoured, all data retained. */
  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@Param('id', Uuid) id: string) {
    return this.workflow.suspend(id);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id', Uuid) id: string) {
    return this.workflow.reactivate(id);
  }

  /** FR-8: export, verify, then provably erase. Resumable; 30-day deadline. */
  @Post(':id/offboard')
  @HttpCode(202)
  offboard(@Param('id', Uuid) id: string, @Req() req: Request & { operator?: { sub: string } }) {
    return this.workflow.start(id, req.operator?.sub ?? '00000000-0000-0000-0000-000000000000');
  }

  /** Move the run one step now (it also advances on a schedule). */
  @Post(':id/offboard/advance')
  @HttpCode(200)
  advance(@Param('id', Uuid) id: string) {
    return this.workflow.advance(id);
  }

  @Get(':id/offboard')
  status(@Param('id', Uuid) id: string) {
    return this.workflow.summary(id);
  }

  /** Per-table before/after for EVERY tenant table, plus Redis, queues and objects; signed. */
  @Get(':id/offboard/report')
  report(@Param('id', Uuid) id: string) {
    return this.workflow.report(id);
  }
}

/** Advances every unfinished offboarding run every 30 s, so a crash anywhere resumes by itself. */
@RegistryFanout('advances unfinished offboarding runs; the tenant work itself runs as tenant-scoped application-plane jobs')
@Processor(OFFBOARDING_QUEUE)
export class OffboardingTickProcessor extends WorkerHost implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(OffboardingTickProcessor.name);

  constructor(
    @InjectQueue(OFFBOARDING_QUEUE) private readonly queue: Queue,
    private readonly workflow: OffboardWorkflow,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('offboarding-tick', { every: 30_000 }, { name: 'tick' }).catch((e: Error) => this.log.warn(`could not schedule offboarding: ${e.message}`));
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(): Promise<number> {
    const pending = await this.workflow.pending();
    for (const id of pending) await this.workflow.advance(id).catch((e: Error) => this.log.warn(`offboarding not advanced yet: ${e.message}`));
    return pending.length;
  }
}
