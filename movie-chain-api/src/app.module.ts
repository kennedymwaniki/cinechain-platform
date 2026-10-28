import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { PublicDiscoveryModule } from './discovery/discovery.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { IdentityModule } from './identity/identity.module';
import { QueueModule } from './queue/queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { StaffModule } from './staff/staff.module';
import { StorageModule } from './storage/storage.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { VenueModule } from './venue/venue.module';

@Module({
  imports: [
    ConfigModule,
    TenancyModule,
    AuditModule,
    CommonModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AuthModule,
    IdentityModule,
    RealtimeModule,
    HealthModule,
    StaffModule,
    VenueModule,
    CatalogueModule,
    SchedulingModule,
    InventoryModule,
    PublicDiscoveryModule,
  ],
})
export class AppModule {}
