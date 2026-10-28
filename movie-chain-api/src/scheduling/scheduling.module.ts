import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { VenueModule } from '../venue/venue.module';
import { ScreeningController } from './screening.controller';
import { ScreeningRepository } from './screening.repository';
import { ScreeningService } from './screening.service';

@Module({
  imports: [VenueModule, CatalogueModule],
  controllers: [ScreeningController],
  providers: [ScreeningRepository, ScreeningService],
  exports: [ScreeningRepository],
})
export class SchedulingModule {}
