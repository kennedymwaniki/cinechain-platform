import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { PublicDiscoveryModule } from './discovery/discovery.module';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './observability/observability.module';
import { PaymentModule } from './payment/payment.module';
import { BookingModule } from './booking/booking.module';
import { TicketingModule } from './ticketing/ticketing.module';
import { NotificationModule } from './notification/notification.module';
import { ReportingModule } from './reporting/reporting.module';
import { ExportModule } from './reporting/export.module';
import { MeteringModule } from './metering/metering.module';
import { TieringModule } from './tiering/tiering.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { BookingMeteringModule } from './metering/booking-metering.module';
import { GuestLinkModule } from './booking/guest-link.module';
import { ReconciliationModule } from './booking/reconciliation.module';
import { InventoryModule } from './inventory/inventory.module';
import { SweeperModule } from './inventory/sweeper.module';
import { IdentityModule } from './identity/identity.module';
import { QueueModule } from './queue/queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { StaffModule } from './staff/staff.module';
import { StorageModule } from './storage/storage.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { VenueModule } from './venue/venue.module';
import { RuntimeGauges } from './observability/runtime-gauges';

@Module({
  imports: [
    ConfigModule,
    TenancyModule,
    AuditModule,
    CommonModule,
    RedisModule,
    ObservabilityModule,
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
    SweeperModule,
    PaymentModule,
    BookingModule,
    TicketingModule,
    NotificationModule,
    ReportingModule,
    ExportModule,
    MeteringModule,
    BookingMeteringModule,
    LifecycleModule,
    TieringModule, // after AuthModule: its guard needs the tenant the access guard set
    GuestLinkModule,
    ReconciliationModule,
    PublicDiscoveryModule,
  ],
  providers: [RuntimeGauges],
})
export class AppModule {}
