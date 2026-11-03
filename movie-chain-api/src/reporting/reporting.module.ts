import { Module } from '@nestjs/common';
import { REPORTING_DB_PROVIDER } from '../tenancy/reporting-db.provider';
import { VenueModule } from '../venue/venue.module';
import { ReportingController } from './reporting.controller';
import { ReportingRepository } from './reporting.repository';
import { ReportingService } from './reporting.service';

/** Its OWN pool (REPORTING_DB_PROVIDER): reports can never exhaust booking's connections. */
@Module({
  imports: [VenueModule],
  controllers: [ReportingController],
  providers: [REPORTING_DB_PROVIDER, ReportingRepository, ReportingService],
  exports: [ReportingService, ReportingRepository],
})
export class ReportingModule {}
