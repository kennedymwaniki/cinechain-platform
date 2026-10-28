import { Controller, Get, Headers, Param, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { ConsumerRoute } from '../auth/decorators';
import { Uuid } from '../common/validation/uuid.pipe';
import type { ConsumerRequest } from '../tenancy/consumer.guard';
import { actorOf } from './hold.controller';
import { HOLD_TOKEN_HEADER, HoldTokenService } from './hold-token.service';
import { SeatmapService } from './seatmap.service';

@ApiTags('public')
@Controller()
export class SeatmapController {
  constructor(
    private readonly seatmaps: SeatmapService,
    private readonly tokens: HoldTokenService,
  ) {}

  /**
   * Guests need no token. A staff token is refused (wrong_token_type). A hold
   * token, if sent, marks the caller's own seats `yours`; a token for another
   * screening (or another chain's) is a 401, never silently ignored.
   */
  @ConsumerRoute()
  @ApiHeader({ name: HOLD_TOKEN_HEADER, required: false })
  @Get('screenings/:id/seatmap')
  async seatmap(@Param('id', Uuid) id: string, @Req() req: ConsumerRequest, @Headers(HOLD_TOKEN_HEADER) holdToken?: string) {
    const holdId = holdToken ? (await this.tokens.verify(holdToken, { screeningId: id })).hold_id : null;
    return this.seatmaps.seatmap(id, actorOf(req), holdId);
  }
}
