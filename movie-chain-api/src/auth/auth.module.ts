import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AccessGuard } from './guards/access.guard';
import { RefreshTokens } from './refresh-token.service';
import { StaffActivationController, StaffActivationService } from './staff-activation';
import { StaffAuthController } from './staff-auth.controller';
import { StaffAuthService } from './staff-auth.service';
import { StaffLocalStrategy } from './strategies/staff-local.strategy';
import { TokensModule } from './tokens.module';
import { ConsumerGuard } from '../tenancy/consumer.guard';

@Module({
  imports: [TokensModule, PassportModule.register({ session: false })],
  controllers: [StaffAuthController, StaffActivationController],
  providers: [
    RefreshTokens,
    StaffAuthService,
    StaffActivationService,
    StaffLocalStrategy,
    ConsumerGuard,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [TokensModule, RefreshTokens, PassportModule],
})
export class AuthModule implements OnModuleInit {
  private readonly log = new Logger(AuthModule.name);

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onModuleInit(): void {
    this.log.log(
      this.cfg.auth.google
        ? 'Google sign-in configured'
        : 'Google sign-in DISABLED (GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL not set)',
    );
  }
}
