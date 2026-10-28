import { Module } from '@nestjs/common';
import { ScreenLayoutPolicy } from './screen-layout.policy';
import { TheatreScope } from './theatre-scope.service';
import { VenueController } from './venue.controller';
import { VenueRepository } from './venue.repository';
import { VenueService } from './venue.service';

@Module({
  controllers: [VenueController],
  providers: [VenueRepository, VenueService, TheatreScope, ScreenLayoutPolicy],
  exports: [VenueRepository, TheatreScope, ScreenLayoutPolicy],
})
export class VenueModule {}
