import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';

const seatIds = z.array(z.uuid()).min(1).max(10);

/** There is structurally nowhere for a caller-supplied tenant_id: .strict() makes one a 400. */
export class CreateHoldDto extends createZodDto(z.object({ seat_ids: seatIds }).strict()) {}

export class BoxOfficeHoldDto extends createZodDto(
  z
    .object({
      screening_id: z.uuid(),
      seat_ids: seatIds,
      // FR-47: a clerk may override the seat-gap rule for the customer in front of them; audited.
      gap_override_reason: z.string().trim().min(3).max(200).optional(),
    })
    .strict(),
) {}
