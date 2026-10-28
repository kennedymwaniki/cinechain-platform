import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentModule } from '../payment/payment.module';
import { TicketingModule } from '../ticketing/ticketing.module';
import { BookingController } from './booking.controller';
import { BookingHistoryService } from './booking-history.service';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { OutboxRelay } from './outbox.relay';
import { RefundService } from './refund.service';
import { BookingTokenService } from './booking-token.service';
import { CancellationService } from './cancellation.service';
import { Reconciler } from './reconciliation.processor';
import { SchedulingModule } from '../scheduling/scheduling.module';

@Module({
  imports: [InventoryModule, CatalogueModule, PaymentModule, IdentityModule, SchedulingModule, TicketingModule],
  controllers: [BookingController],
  providers: [BookingRepository, BookingService, BookingHistoryService, RefundService, OutboxRelay, BookingTokenService, CancellationService, Reconciler],
  exports: [BookingService, BookingRepository, RefundService, OutboxRelay, BookingTokenService, Reconciler],
})
export class BookingModule {}
