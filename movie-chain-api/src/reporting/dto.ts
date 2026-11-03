import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';

const range = {
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
};

export class OccupancyQuery extends createZodDto(z.object({ ...range, theatre_id: z.uuid().optional() }).strict()) {}
export class RevenueQuery extends createZodDto(z.object(range).strict()) {}
export class CreateExportDto extends createZodDto(z.object({ kind: z.enum(['revenue', 'occupancy']), ...range }).strict()) {}
