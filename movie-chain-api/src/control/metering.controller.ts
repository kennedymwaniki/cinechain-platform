import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';
import { MeteringAggregator } from '../metering/aggregator.processor';
import { MeteringRepository } from '../metering/metering.repository';
import { periodOf } from '../metering/usage.recorder';

export class MeteringQuery extends createZodDto(
  z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM').optional() }).strict(),
) {}

/** Control plane (operators only, 127.0.0.1). Counts per tenant; nothing that identifies a booking or a person. */
@ApiTags('metering')
@ApiBearerAuth()
@Controller('admin/metering')
export class MeteringController {
  constructor(
    private readonly repo: MeteringRepository,
    private readonly aggregator: MeteringAggregator,
  ) {}

  @Get()
  async list(@Query() q: MeteringQuery) {
    const period = q.period ?? periodOf();
    const rows = await this.repo.list(period);
    return { period, tenants: rows.map((r) => ({ ...r, updated_at: r.updated_at.toISOString() })) };
  }

  /** Fold now, instead of waiting for the next 5-minute tick. */
  @Post('aggregate')
  @HttpCode(200)
  aggregate() {
    return this.aggregator.aggregate();
  }
}
