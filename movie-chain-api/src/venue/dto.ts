import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';
import { SCREEN_FORMATS, SEAT_CLASSES } from '../db/schema/venue';
import { MAX_ROWS, MAX_SEATS_PER_ROW } from './seat-layout.generator';

/** At least an hour for cleaning; a chain or hall may choose longer. */
export const turnaroundMinutes = z.number().int().min(60, 'at least 60 minutes for cleaning').max(240);

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'must be an IANA time zone, e.g. Africa/Nairobi');

const theatreFields = {
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(80),
  address: z.string().trim().max(240).nullable().optional(),
  timezone: timezone.default('Africa/Nairobi'),
  contact_phone: z.string().trim().max(30).nullable().optional(),
};
export class CreateTheatreDto extends createZodDto(z.object(theatreFields).strict()) {}
export class UpdateTheatreDto extends createZodDto(
  z
    .object({ ...theatreFields, timezone: timezone })
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'nothing to update'),
) {}

export class CreateScreenDto extends createZodDto(
  z
    .object({
      theatre_id: z.uuid(),
      name: z.string().trim().min(1).max(60),
      format: z.enum(SCREEN_FORMATS).default('standard'),
      // null / omitted = use the chain's default
      turnaround_minutes: turnaroundMinutes.nullable().optional(),
    })
    .strict(),
) {}

export class UpdateScreenDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      turnaround_minutes: turnaroundMinutes.nullable().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'nothing to update'),
) {}

const seatClass = z.enum(SEAT_CLASSES);
export class GenerateSeatsDto extends createZodDto(
  z
    .object({
      rows: z.number().int().min(1).max(MAX_ROWS),
      seatsPerRow: z.number().int().min(1).max(MAX_SEATS_PER_ROW),
      defaultClass: seatClass.default('standard'),
      aisleAfter: z.array(z.number().int().min(1)).max(10).optional(),
      rowClasses: z.array(z.object({ rows: z.array(z.string().regex(/^[A-Z]{1,2}$/)).min(1), seatClass }).strict()).max(20).optional(),
      seatClasses: z.array(z.object({ seat: z.string().regex(/^[A-Z]{1,2}\d{1,3}$/), seatClass }).strict()).max(200).optional(),
    })
    .strict(),
) {}

export class UpdateSeatDto extends createZodDto(
  z
    .object({ seat_class: seatClass.optional(), is_active: z.boolean().optional() })
    .strict()
    .refine((v) => v.seat_class !== undefined || v.is_active !== undefined, 'nothing to update'),
) {}

export class OutOfServiceDto extends createZodDto(
  z
    .object({
      reason: z.string().trim().min(3).max(240),
      until: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
) {}
