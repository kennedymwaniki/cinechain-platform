import { Body, Controller, Delete, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { ConsumerRoute, Roles } from '../auth/decorators';
import { Uuid } from '../common/validation/uuid.pipe';
import type { ConsumerRequest } from '../tenancy/consumer.guard';
import { DeferTenantTransaction } from '../tenancy/decorators';
import type { Actor } from '../tenancy/tenant-context';
import { BoxOfficeHoldService } from './box-office-hold.service';
import { BoxOfficeHoldDto, CreateHoldDto } from './dto';
import { HOLD_TOKEN_HEADER } from './hold-token.service';
import { HoldService } from './hold.service';

export const actorOf = (req: ConsumerRequest): Actor =>
  req.consumer ? { kind: 'consumer', consumerId: req.consumer.id } : { kind: 'guest' };

/**
 * Holds. Guests need no account: possession of the signed hold token is the
 * claim to the seats (FR-70, FR-71). The handlers open their own short
 * tenant scopes, so no connection is pinned across the Redis round trip.
 */
@ApiTags('holds')
@Controller()
export class HoldController {
  constructor(
    private readonly holds: HoldService,
    private readonly boxOffice: BoxOfficeHoldService,
  ) {}

  @ConsumerRoute()
  @DeferTenantTransaction()
  @Post('screenings/:id/holds')
  create(@Param('id', Uuid) id: string, @Body() body: CreateHoldDto, @Req() req: ConsumerRequest) {
    return this.holds.placeOnline(id, body.seat_ids, actorOf(req));
  }

  @ConsumerRoute()
  @DeferTenantTransaction()
  @ApiHeader({ name: HOLD_TOKEN_HEADER, required: true })
  @HttpCode(204)
  @Delete('holds/:id')
  async release(@Param('id', Uuid) id: string, @Headers(HOLD_TOKEN_HEADER) token: string | undefined, @Req() req: ConsumerRequest) {
    await this.holds.release(id, token, actorOf(req));
  }

  @ConsumerRoute()
  @DeferTenantTransaction()
  @ApiHeader({ name: HOLD_TOKEN_HEADER, required: true })
  @HttpCode(200)
  @Post('holds/:id/extend')
  extend(@Param('id', Uuid) id: string, @Headers(HOLD_TOKEN_HEADER) token: string | undefined, @Req() req: ConsumerRequest) {
    return this.holds.extend(id, token, actorOf(req));
  }

  /** FR-48. Tenant from the clerk's JWT; theatre-scoped. */
  @Roles('box_office', 'theatre_manager', 'chain_admin')
  @DeferTenantTransaction()
  @Post('box-office/holds')
  boxOfficeHold(@Body() body: BoxOfficeHoldDto) {
    return this.boxOffice.place({ screeningId: body.screening_id, seatIds: body.seat_ids, gapOverrideReason: body.gap_override_reason });
  }
}
