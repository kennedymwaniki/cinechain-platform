import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators';
import { DeferTenantTransaction } from '../tenancy/decorators';
import { OccupancyQuery, RevenueQuery } from './dto';
import { ReportingService } from './reporting.service';

/**
 * @DeferTenantTransaction on every route: the interceptor must NOT open a
 * booking-pool transaction; the service opens one on the reporting pool.
 */
@ApiTags('reports')
@Controller('reports')
export class ReportingController {
  constructor(private readonly reports: ReportingService) {}

  /** Live occupancy per screening, within the caller's theatres (FR-65). */
  @Roles('theatre_manager', 'chain_admin')
  @DeferTenantTransaction()
  @Get('occupancy')
  occupancy(@Query() q: OccupancyQuery) {
    return this.reports.occupancy(new Date(q.from), new Date(q.to), q.theatre_id);
  }

  /** Chain-wide revenue across every theatre (FR-65). Cached ≤ 60 s; the body says so. */
  @Roles('chain_admin')
  @DeferTenantTransaction()
  @Get('revenue')
  revenue(@Query() q: RevenueQuery) {
    return this.reports.revenue(new Date(q.from), new Date(q.to));
  }
}
