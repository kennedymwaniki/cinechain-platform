import { SkipRateLimit } from '../tiering/decorators';
import { Controller, HttpCode, Param, Post, type RawBodyRequest, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { PaymentWebhookService } from './payment-webhook.service';

@ApiTags('payments')
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  /**
   * @Public (the provider has no token), yet tenant-scoped: the tenant comes
   * from the stored payment row, never from the request.
   */
  @SkipRateLimit() // providers retry on their own schedule; their signature is the gate
  @Public()
  @ApiExcludeEndpoint()
  @HttpCode(200)
  @Post(':provider')
  receive(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    return this.webhooks.handle(provider, req.rawBody, req.headers);
  }
}
