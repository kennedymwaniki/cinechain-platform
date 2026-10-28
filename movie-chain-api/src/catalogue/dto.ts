import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';
import { FILM_RATINGS } from '../db/schema/catalogue';
import { SCREEN_FORMATS, SEAT_CLASSES } from '../db/schema/venue';

const filmFields = {
  title: z.string().trim().min(1).max(200),
  synopsis: z.string().trim().max(4000).nullable().optional(),
  runtime_min: z.number().int().min(1).max(600),
  rating: z.enum(FILM_RATINGS).nullable().optional(),
  language: z.string().trim().min(2).max(40).nullable().optional(),
  release_date: z.iso.date().nullable().optional(),
};
export class CreateFilmDto extends createZodDto(z.object(filmFields).strict()) {}
export class UpdateFilmDto extends createZodDto(
  z.object(filmFields).partial().strict().refine((v) => Object.keys(v).length > 0, 'nothing to update'),
) {}

export class CreatePricingRuleDto extends createZodDto(
  z
    .object({
      seat_class: z.enum(SEAT_CLASSES),
      format: z.enum(SCREEN_FORMATS).nullable().default(null),
      // integer minor units — the currency is the chain's, set server-side
      price_minor: z.number().int().min(0).max(100_000_000),
      effective_from: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
) {}
