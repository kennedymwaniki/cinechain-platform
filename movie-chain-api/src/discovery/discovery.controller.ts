import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../auth/decorators';
import { createZodDto } from '../common/validation/zod-dto';
import { Uuid } from '../common/validation/uuid.pipe';
import { FILM_RATINGS } from '../db/schema/catalogue';
import { SCREEN_FORMATS } from '../db/schema/venue';
import { DiscoveryService } from './discovery.service';

const DAY = 86_400_000;
const range = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};
class BrowseQuery extends createZodDto(
  z
    .object({
      city: z.string().trim().min(1).max(80).optional(),
      title: z.string().trim().min(1).max(100).optional(),
      language: z.string().trim().min(2).max(40).optional(),
      rating: z.enum(FILM_RATINGS).optional(),
      format: z.enum(SCREEN_FORMATS).optional(),
      ...range,
    })
    .strict(),
) {}
class ScreeningsQuery extends createZodDto(z.object({ city: z.string().trim().min(1).max(80).optional(), ...range }).strict()) {}

const window = (q: { from?: string | undefined; to?: string | undefined }) => {
  const from = q.from ? new Date(q.from) : new Date();
  return { from, to: q.to ? new Date(q.to) : new Date(from.getTime() + 7 * DAY) };
};

/** Public: no account, no token. Spans every chain on the platform. */
@ApiTags('public')
@Controller('discover')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Public()
  @Get('films')
  films(@Query() q: BrowseQuery) {
    return this.discovery.films({ ...window(q), city: q.city, title: q.title, language: q.language, rating: q.rating, format: q.format });
  }

  @Public()
  @Get('films/:id/screenings')
  screenings(@Param('id', Uuid) id: string, @Query() q: ScreeningsQuery) {
    return this.discovery.screenings(id, { ...window(q), city: q.city });
  }
}
