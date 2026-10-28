import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators';
import { Uuid } from '../common/validation/uuid.pipe';
import { CopyScheduleDto, CreateScreeningDto, ListScreeningsQuery } from './dto';
import { ScreeningService } from './screening.service';

const MANAGERS = ['chain_admin', 'theatre_manager'] as const;

@ApiTags('scheduling')
@ApiBearerAuth()
@Controller()
export class ScreeningController {
  constructor(private readonly screenings: ScreeningService) {}

  @Roles(...MANAGERS)
  @Post('screenings')
  create(@Body() b: CreateScreeningDto) {
    return this.screenings.create({
      screenId: b.screen_id,
      filmId: b.film_id,
      startsAt: new Date(b.starts_at),
      turnaroundMinutes: b.turnaround_minutes ?? null,
    });
  }

  @Get('screenings')
  list(@Query() q: ListScreeningsQuery) {
    return this.screenings.list({
      theatreId: q.theatre_id,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Get('screenings/:id')
  get(@Param('id', Uuid) id: string) {
    return this.screenings.get(id);
  }

  @Roles(...MANAGERS)
  @Post('screenings/:id/publish')
  @HttpCode(200)
  publish(@Param('id', Uuid) id: string) {
    return this.screenings.transition(id, 'published');
  }

  @Roles(...MANAGERS)
  @Post('screenings/:id/close')
  @HttpCode(200)
  close(@Param('id', Uuid) id: string) {
    return this.screenings.transition(id, 'closed');
  }

  @Roles(...MANAGERS)
  @Post('screenings/:id/complete')
  @HttpCode(200)
  complete(@Param('id', Uuid) id: string) {
    return this.screenings.transition(id, 'completed');
  }

  /** Step 19 extends this with releasing holds and refunding tickets (FR-26). */
  @Roles(...MANAGERS)
  @Post('screenings/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', Uuid) id: string) {
    return this.screenings.transition(id, 'cancelled');
  }

  @Roles(...MANAGERS)
  @Post('screenings\\:copy')
  copy(@Body() b: CopyScheduleDto) {
    return this.screenings.copy({ theatreId: b.theatre_id, fromDate: b.from_date, toDate: b.to_date, span: b.span });
  }
}
