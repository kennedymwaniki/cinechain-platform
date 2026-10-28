import { z } from 'zod';
import { badRequest } from '../../common/errors/api-error';
import type { CaptureRequest, WebhookEvent } from '../payment.provider';
import { GatewayProvider } from './gateway-provider';

/** Daraja's STK-push callback shape (the parts we use). */
const callback = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string(),
      ResultCode: z.number().int(),
      ResultDesc: z.string(),
    }),
  }),
});

export const KENYAN_MSISDN = /^\+2547\d{8}$|^\+2541\d{8}$/;

/** M-Pesa STK push: the customer confirms on their handset (~20 s), then Safaricom calls back. */
export class MpesaProvider extends GatewayProvider {
  readonly name = 'mpesa' as const;

  protected checkMethod(req: CaptureRequest): undefined {
    if (req.method.kind !== 'mpesa') throw badRequest('invalid_payment_method', 'MpesaProvider got a non-M-Pesa method');
    if (!KENYAN_MSISDN.test(req.method.phone)) throw badRequest('invalid_payment_method', 'invalid M-Pesa phone number');
    if (req.amount.currency !== 'KES') throw badRequest('invalid_payment_method', 'M-Pesa charges KES only');
    return undefined;
  }

  protected parseWebhook(body: unknown): WebhookEvent | null {
    const p = callback.safeParse(body);
    if (!p.success) return null;
    const cb = p.data.Body.stkCallback;
    return {
      // One callback per checkout and outcome: a re-delivery repeats the same id.
      eventId: `${cb.CheckoutRequestID}:${cb.ResultCode}`,
      providerRef: cb.CheckoutRequestID,
      status: cb.ResultCode === 0 ? 'captured' : 'failed',
      ...(cb.ResultCode === 0 ? {} : { reason: cb.ResultDesc }),
    };
  }
}
