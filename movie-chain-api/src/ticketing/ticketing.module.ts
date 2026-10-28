import { Module } from '@nestjs/common';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AdmissionService } from './admission.service';
import { TicketQrService } from './qr.service';
import { TicketCodeService } from './ticket-code.service';
import { TicketController } from './ticket.controller';

@Module({
  imports: [SchedulingModule],
  controllers: [TicketController],
  providers: [TicketCodeService, TicketQrService, AdmissionService, RateLimiter],
  exports: [TicketCodeService, TicketQrService, RateLimiter],
})
export class TicketingModule {}
