import { z } from 'zod';
import { badRequest } from '../../common/errors/api-error';
import type { CaptureRequest, WebhookEvent } from '../payment.provider';
import { GatewayProvider } from './gateway-provider';

const event = z.object({
  id: z.string().min(1),
  type: z.enum(['charge.succeeded', 'charge.failed']),
  data: z.object({ charge_id: z.string().min(1), failure_message: z.string().optional() }),
});

/**
 * Card payments through provider-hosted fields (SAQ-A). We receive a token
 * minted by the provider's own iframe and never see a PAN, CVV or expiry.
 * The stub token format is `tok_<anything>_<last4>`.
 */
export class CardProvider extends GatewayProvider {
  readonly name = 'card' as const;

  protected checkMethod(req: CaptureRequest): string {
    if (req.method.kind !== 'card') throw badRequest('invalid_payment_method', 'CardProvider got a non-card method');
    const m = /^tok_[A-Za-z0-9]+_(\d{4})$/.exec(req.method.cardToken);
    if (!m) throw badRequest('invalid_payment_method', 'invalid card token');
    return m[1]!;
  }

  protected parseWebhook(body: unknown): WebhookEvent | null {
    const p = event.safeParse(body);
    if (!p.success) return null;
    return {
      eventId: p.data.id,
      providerRef: p.data.data.charge_id,
      status: p.data.type === 'charge.succeeded' ? 'captured' : 'failed',
      ...(p.data.data.failure_message ? { reason: p.data.data.failure_message } : {}),
    };
  }
}
