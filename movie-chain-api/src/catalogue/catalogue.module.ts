import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller';
import { CatalogueRepository } from './catalogue.repository';
import { FilmService } from './film.service';
import { PricingService } from './pricing.service';

@Module({
  controllers: [CatalogueController],
  providers: [CatalogueRepository, FilmService, PricingService],
  exports: [CatalogueRepository, PricingService],
})
export class CatalogueModule {}
