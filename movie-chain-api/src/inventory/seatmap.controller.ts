import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConsumerRoute } from '../auth/decorators';
import { Uuid } from '../common/validation/uuid.pipe';
import type { ConsumerRequest } from '../tenancy/consumer.guard';
import { SeatmapService } from './seatmap.service';

@ApiTags('public')
@Controller()
export class SeatmapController {
  constructor(private readonly seatmaps: SeatmapService) {}

  /** Guests need no token. A staff token is refused (wrong_token_type). */
  @ConsumerRoute()
  @Get('screenings/:id/seatmap')
  seatmap(@Param('id', Uuid) id: string, @Req() req: ConsumerRequest) {
    const actor = req.consumer ? ({ kind: 'consumer', consumerId: req.consumer.id } as const) : ({ kind: 'guest' } as const);
    // Step 13 passes the caller's hold id (from their hold token) for "yours".
    return this.seatmaps.seatmap(id, actor, null);
  }
}
