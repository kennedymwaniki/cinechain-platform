import { Logger, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KeyStore } from '../auth/key-store';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { ConsumerAuthController } from './consumer-auth.controller';
import { ConsumerService } from './consumer.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { LogVerificationMailer, VerificationMailer } from './verification-mailer';

@Module({
  imports: [AuthModule],
  controllers: [ConsumerAuthController],
  providers: [
    ConsumerService,
    LogVerificationMailer,
    { provide: VerificationMailer, useExisting: LogVerificationMailer },
    {
      // Constructing the strategy registers it with passport; without the
      // Google env trio it is never constructed and /auth/google is a 404.
      provide: GoogleStrategy,
      inject: [APP_CONFIG, KeyStore],
      useFactory: (cfg: AppConfig, keys: KeyStore) => {
        if (!cfg.auth.google) return null;
        new Logger('IdentityModule').log('Google OAuth strategy registered');
        return new GoogleStrategy(cfg, keys);
      },
    },
  ],
  exports: [ConsumerService],
})
export class IdentityModule {}
