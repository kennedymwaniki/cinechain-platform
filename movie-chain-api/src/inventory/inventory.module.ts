import { Module } from '@nestjs/common';
import { SeatmapController } from './seatmap.controller';
import { SeatmapRepository } from './seatmap.repository';
import { SeatmapService } from './seatmap.service';

@Module({
  controllers: [SeatmapController],
  providers: [SeatmapRepository, SeatmapService],
  exports: [SeatmapService],
})
export class InventoryModule {}
