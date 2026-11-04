import { BullModule } from '@nestjs/bullmq';
import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { TokensModule } from '../auth/tokens.module';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { ConfigModule } from '../config/config.module';
import { QueueModule } from '../queue/queue.module';
import { RedisModule } from '../redis/redis.module';
import { CONTROL_DB_PROVIDER, ControlDb } from '../tenancy/control-db.provider';
import { ControlExceptionsFilter } from './control-exceptions.filter';
import { ControlHealthController } from './control-health.controller';
import { ControlMetricsController } from './control-metrics.controller';
import { METERING_QUEUE, MeteringAggregator, MeteringAggregatorProcessor } from '../metering/aggregator.processor';
import { MeteringController } from './metering.controller';
import { TiersController } from './tiers.controller';
import { BillingController } from './billing/billing.controller';
import { BILLING_QUEUE, BillingProcessor } from './billing/billing.processor';
import { CostAllocator } from './billing/cost-allocator.service';
import { DunningService, SubscriptionBillingGateway } from './billing/dunning.service';
import { InvoiceGenerator } from './billing/invoice.generator';
import { DeletionReportSigner } from './offboarding/deletion-report';
import { DeletionService } from './offboarding/deletion.service';
import { LifecycleController, OFFBOARDING_QUEUE, OffboardingTickProcessor } from './offboarding/lifecycle.controller';
import { OffboardWorkflow } from './offboarding/offboard.workflow';
import { LIFECYCLE_QUEUE } from '../lifecycle/lifecycle.processor';
import { MeteringRepository } from '../metering/metering.repository';
import { registerProducerQueue } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { OperatorAuthController, OperatorGuard } from './auth/operator-auth';
import { OnboardingController } from './onboarding/onboarding.controller';
import { OnboardingProcessor } from './onboarding/onboarding.processor';
import { ONBOARDING_QUEUE, OnboardingService } from './onboarding/onboarding.service';
import { StaffInviteMailer } from '../staff/staff-invite.mailer';

/**
 * The control plane: a SEPARATE process (main-control.ts, :3001) on a
 * SEPARATE database role. "Operators cannot read booking data" is a GRANT,
 * not a convention — cinechain_control has none on booking/ticket/payment.
 */
@Module({
  imports: [
    ConfigModule,
    RedisModule,
    QueueModule,
    TokensModule,
    StorageModule,
    registerProducerQueue(METERING_QUEUE),
    registerProducerQueue(BILLING_QUEUE),
    registerProducerQueue(OFFBOARDING_QUEUE),
    registerProducerQueue(LIFECYCLE_QUEUE), // consumed by the APPLICATION plane
    BullModule.registerQueueAsync({
      name: ONBOARDING_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        defaultJobOptions: { attempts: cfg.onboarding.attempts, backoff: { type: 'exponential', delay: 1000 } },
      }),
    }),
  ],
  controllers: [OperatorAuthController, OnboardingController, ControlHealthController, ControlMetricsController, MeteringController, TiersController, BillingController, LifecycleController],
  providers: [
    CONTROL_DB_PROVIDER,
    OnboardingService,
    OnboardingProcessor,
    StaffInviteMailer,
    MeteringRepository,
    MeteringAggregator,
    MeteringAggregatorProcessor,
    InvoiceGenerator,
    CostAllocator,
    DunningService,
    // The platform's own billing account: a separate instance from any ticket provider.
    { provide: SubscriptionBillingGateway, useValue: new SubscriptionBillingGateway() },
    BillingProcessor,
    OffboardWorkflow,
    DeletionService,
    DeletionReportSigner,
    OffboardingTickProcessor,
    { provide: APP_GUARD, useClass: OperatorGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ControlExceptionsFilter },
  ],
})
export class ControlAppModule implements OnModuleInit {
  private readonly log = new Logger(ControlAppModule.name);

  constructor(@Inject(ControlDb) private readonly db: ControlDb) {}

  async onModuleInit(): Promise<void> {
    await this.db.assertSafeControlRole();
    this.log.log('control role verified: no booking/ticket/payment, no consumer directory');
  }
}
