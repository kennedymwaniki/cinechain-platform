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
    BullModule.registerQueueAsync({
      name: ONBOARDING_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        defaultJobOptions: { attempts: cfg.onboarding.attempts, backoff: { type: 'exponential', delay: 1000 } },
      }),
    }),
  ],
  controllers: [OperatorAuthController, OnboardingController, ControlHealthController],
  providers: [
    CONTROL_DB_PROVIDER,
    OnboardingService,
    OnboardingProcessor,
    StaffInviteMailer,
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
