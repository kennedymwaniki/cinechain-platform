import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';

/** The code travels in the BODY, never the path: paths end up in access logs. */
export class RedeemTicketDto extends createZodDto(
  z
    .object({
      code: z.string().min(1).max(64),
      screening_id: z.uuid(),
      device_id: z.string().trim().min(1).max(64),
    })
    .strict(),
) {}
