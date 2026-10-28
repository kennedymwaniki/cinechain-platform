import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';
import { turnaroundMinutes } from '../venue/dto';

export class CreateScreeningDto extends createZodDto(
  z
    .object({
      screen_id: z.uuid(),
      film_id: z.uuid(),
      starts_at: z.iso.datetime({ offset: true }),
      // optional one-off, e.g. a premiere's deep clean; omitted = the screen's, then the chain's default
      turnaround_minutes: turnaroundMinutes.optional(),
    })
    .strict(),
) {}

export class CopyScheduleDto extends createZodDto(
  z
    .object({
      theatre_id: z.uuid(),
      // LOCAL calendar dates in the theatre's time zone
      from_date: z.iso.date(),
      to_date: z.iso.date(),
      span: z.enum(['day', 'week']),
    })
    .strict(),
) {}

export class ListScreeningsQuery extends createZodDto(
  z
    .object({
      theatre_id: z.uuid().optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
) {}
