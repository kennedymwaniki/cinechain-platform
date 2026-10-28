import { Body, Controller, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators';
import { Uuid } from '../common/validation/uuid.pipe';
import { definedOnly } from '../shared/defined';
import { CreateFilmDto, CreatePricingRuleDto, UpdateFilmDto } from './dto';
import { FilmService } from './film.service';
import { MAX_POSTER_BYTES } from './poster';
import { PricingService } from './pricing.service';

@ApiTags('catalogue')
@ApiBearerAuth()
@Controller()
export class CatalogueController {
  constructor(
    private readonly films: FilmService,
    private readonly pricing: PricingService,
  ) {}

  @Roles('chain_admin')
  @Post('films')
  createFilm(@Body() b: CreateFilmDto) {
    return this.films.create({
      title: b.title,
      synopsis: b.synopsis ?? null,
      runtimeMin: b.runtime_min,
      rating: b.rating ?? null,
      language: b.language ?? null,
      releaseDate: b.release_date ?? null,
    });
  }

  @Get('films')
  listFilms(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.films.list(limit, cursor);
  }

  @Get('films/:id')
  getFilm(@Param('id', Uuid) id: string) {
    return this.films.get(id);
  }

  @Roles('chain_admin')
  @Patch('films/:id')
  updateFilm(@Param('id', Uuid) id: string, @Body() b: UpdateFilmDto) {
    return this.films.update(
      id,
      definedOnly({
        title: b.title,
        synopsis: b.synopsis,
        runtimeMin: b.runtime_min,
        rating: b.rating,
        language: b.language,
        releaseDate: b.release_date,
      }),
    );
  }

  @Roles('chain_admin')
  @Post('films/:id/poster')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { poster: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('poster', { limits: { fileSize: MAX_POSTER_BYTES + 1, files: 1 } }))
  setPoster(@Param('id', Uuid) id: string, @UploadedFile() file?: { buffer: Buffer; size: number }) {
    return this.films.setPoster(id, file);
  }

  @Get('pricing-rules')
  listRules() {
    return this.pricing.list();
  }

  @Roles('chain_admin')
  @Post('pricing-rules')
  createRule(@Body() b: CreatePricingRuleDto) {
    return this.pricing.create({
      seatClass: b.seat_class,
      format: b.format,
      priceMinor: b.price_minor,
      effectiveFrom: b.effective_from ? new Date(b.effective_from) : null,
    });
  }
}
