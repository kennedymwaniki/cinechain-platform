import { Global, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BookingTokenService } from '../booking/booking-token.service';
import { InventoryModule } from '../inventory/inventory.module';
import { TenantRateLimitGuard } from './rate-limit.guard';
import { TierConfig } from './tier-config.service';
import { TenantRateLimiter } from './tenant-rate-limiter';
import { EarlyRefusalMiddleware } from './early-refusal.middleware';
import { ScreeningTenants } from './screening-tenants';

/**
 * Tiers as configuration (step 25). Import AFTER AuthModule: global guards run
 * in registration order, and this one needs the tenant the access guard set.
 */
@Global()
@Module({
  imports: [InventoryModule],
  providers: [TierConfig, TenantRateLimiter, ScreeningTenants, EarlyRefusalMiddleware, BookingTokenService, { provide: APP_GUARD, useClass: TenantRateLimitGuard }],
  exports: [TierConfig],
})
export class TieringModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(EarlyRefusalMiddleware)
      .forRoutes({ path: 'screenings/:id/seatmap', method: RequestMethod.GET }, { path: 'screenings/:id/holds', method: RequestMethod.POST });
  }
}
