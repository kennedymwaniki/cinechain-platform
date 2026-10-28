import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators';
import { Uuid } from '../common/validation/uuid.pipe';
import { definedOnly } from '../shared/defined';
import {
  CreateScreenDto,
  CreateTheatreDto,
  GenerateSeatsDto,
  OutOfServiceDto,
  UpdateScreenDto,
  UpdateSeatDto,
  UpdateTheatreDto,
} from './dto';
import { VenueService } from './venue.service';

@ApiTags('venues')
@ApiBearerAuth()
@Controller()
export class VenueController {
  constructor(private readonly venues: VenueService) {}

  @Roles('chain_admin')
  @Post('theatres')
  createTheatre(@Body() b: CreateTheatreDto) {
    return this.venues.createTheatre({
      name: b.name,
      city: b.city,
      address: b.address ?? null,
      timezone: b.timezone,
      contactPhone: b.contact_phone ?? null,
    });
  }

  @Get('theatres')
  listTheatres() {
    return this.venues.listTheatres();
  }

  @Get('theatres/:id')
  getTheatre(@Param('id', Uuid) id: string) {
    return this.venues.getTheatre(id);
  }

  @Roles('chain_admin')
  @Patch('theatres/:id')
  updateTheatre(@Param('id', Uuid) id: string, @Body() b: UpdateTheatreDto) {
    return this.venues.updateTheatre(
      id,
      definedOnly({ name: b.name, city: b.city, address: b.address, timezone: b.timezone, contactPhone: b.contact_phone }),
    );
  }

  @Roles('chain_admin', 'theatre_manager')
  @Post('screens')
  createScreen(@Body() b: CreateScreenDto) {
    return this.venues.createScreen({
      theatreId: b.theatre_id,
      name: b.name,
      format: b.format,
      turnaroundMinutes: b.turnaround_minutes ?? null,
    });
  }

  @Roles('chain_admin', 'theatre_manager')
  @Patch('screens/:id')
  updateScreen(@Param('id', Uuid) id: string, @Body() b: UpdateScreenDto) {
    return this.venues.updateScreen(id, definedOnly({ name: b.name, turnaroundMinutes: b.turnaround_minutes }));
  }

  @Get('screens/:id')
  getScreen(@Param('id', Uuid) id: string) {
    return this.venues.getScreen(id);
  }

  @Roles('chain_admin', 'theatre_manager')
  @Post('screens/:id/seats\\:generate')
  @HttpCode(201)
  generate(@Param('id', Uuid) id: string, @Body() b: GenerateSeatsDto) {
    return this.venues.generateSeats(id, b);
  }

  @Roles('chain_admin', 'theatre_manager')
  @Post('screens/:id/out-of-service')
  @HttpCode(200)
  outOfService(@Param('id', Uuid) id: string, @Body() b: OutOfServiceDto) {
    return this.venues.setOutOfService(id, b.reason, b.until ? new Date(b.until) : null);
  }

  @Roles('chain_admin', 'theatre_manager')
  @Post('screens/:id/restore')
  @HttpCode(200)
  restore(@Param('id', Uuid) id: string) {
    return this.venues.restore(id);
  }

  @Roles('chain_admin', 'theatre_manager')
  @Patch('seats/:id')
  updateSeat(@Param('id', Uuid) id: string, @Body() b: UpdateSeatDto) {
    return this.venues.updateSeat(id, definedOnly({ seatClass: b.seat_class, isActive: b.is_active }));
  }
}
