import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { VenueModule } from '../venue/venue.module';
import { BoxOfficeHoldService } from './box-office-hold.service';
import { HoldController } from './hold.controller';
import { HoldRepository } from './hold.repository';
import { HoldService } from './hold.service';
import { HoldTokenService } from './hold-token.service';
import { InventoryEvents } from './inventory-events';
import { RedisLocks } from './redis-locks';
import { SeatmapController } from './seatmap.controller';
import { SeatmapRepository } from './seatmap.repository';
import { SeatmapService } from './seatmap.service';

@Module({
  imports: [CatalogueModule, VenueModule],
  controllers: [SeatmapController, HoldController],
  providers: [SeatmapRepository, SeatmapService, HoldRepository, HoldService, HoldTokenService, RedisLocks, BoxOfficeHoldService, InventoryEvents],
  exports: [SeatmapService, HoldService, HoldTokenService, HoldRepository, RedisLocks, InventoryEvents],
})
export class InventoryModule {}
