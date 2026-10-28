import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public, Roles } from '../auth/decorators';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { currentTenant } from '../tenancy/tenant-context';
import { AdmissionService } from './admission.service';
import { RedeemTicketDto } from './dto';
import { TicketQrService } from './qr.service';

@ApiTags('tickets')
@Controller('tickets')
export class TicketController {
  constructor(
    private readonly admission: AdmissionService,
    private readonly qr: TicketQrService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * FR-60: a clerk scans. 200 with `valid | already_used | wrong_screening |
   * wrong_day | void | invalid` — a scanner shows a result, it does not branch on HTTP status.
   */
  @Roles('box_office', 'theatre_manager', 'chain_admin')
  @HttpCode(200)
  @Post('redeem')
  async redeem(@Body() body: RedeemTicketDto) {
    const { actor } = currentTenant();
    await this.limiter.consume(`redeem:${actor.kind === 'staff' ? actor.userId : 'x'}`, 600, 60);
    return this.admission.redeem(body.code, body.screening_id, body.device_id);
  }

  /** The QR image behind a ticket's short-lived `qr_url`. */
  @Public()
  @Get('qr')
  async image(@Query('token') token: string | undefined, @Res() res: Response) {
    const png = await this.qr.render(token);
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'private, no-store');
    res.send(png);
  }
}
