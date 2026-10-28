import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type CaptureRequest,
  type CaptureResult,
  PaymentProvider,
  type RefundRequest,
  type RefundResult,
  type WebhookEvent,
} from '../payment.provider';
import { StubGateway } from './stub-gateway';

export const SIGNATURE_HEADER = 'x-cinechain-signature';
/** A signed webhook older than this is a replay, even with a valid signature. */
export const WEBHOOK_TOLERANCE_S = 300;

const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` */
export function signWebhook(secret: string, rawBody: string | Buffer, at = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${at}.`).update(rawBody).digest('hex');
  return `t=${at},v1=${mac}`;
}

/**
 * The shared shape of a hosted payment provider. Subclasses supply the
 * method check and the webhook body format.
 */
export abstract class GatewayProvider extends PaymentProvider {
  /** How long a capture waits for the provider before reporting `pending`. */
  pollAttempts = 10;
  pollIntervalMs = 200;

  constructor(
    readonly gateway: StubGateway,
    private readonly webhookSecret: string,
  ) {
    super();
  }

  protected abstract checkMethod(req: CaptureRequest): string | undefined; // → card last4, if any
  protected abstract parseWebhook(body: unknown): WebhookEvent | null;

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    // Never blind-retry: if this key already reached the provider, its answer stands.
    const prior = await this.status(req.idempotencyKey);
    if (prior) return prior.status === 'pending' ? this.poll(req.idempotencyKey) : prior;

    const last4 = this.checkMethod(req);
    const r = this.gateway.charge(req.idempotencyKey, req.amount, last4);
    if (r.outcome === 'captured') return { status: 'captured', providerRef: r.ref, capturedAt: new Date(), ...(last4 ? { cardLast4: last4 } : {}) };
    if (r.outcome === 'failed') return { status: 'failed', providerRef: r.ref, reason: 'declined' };
    return this.poll(req.idempotencyKey); // timeout / pending: ask, do not charge again
  }

  private async poll(key: string): Promise<CaptureResult> {
    for (let i = 0; i < this.pollAttempts; i++) {
      const s = await this.status(key);
      if (s && s.status !== 'pending') return s;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    return { status: 'pending', providerRef: this.gateway.lookup(key)?.ref ?? null };
  }

  async status(idempotencyKey: string): Promise<CaptureResult | null> {
    const c = this.gateway.lookup(idempotencyKey);
    if (!c) return null;
    if (c.outcome === 'captured') return { status: 'captured', providerRef: c.ref, capturedAt: new Date(), ...(c.last4 ? { cardLast4: c.last4 } : {}) };
    if (c.outcome === 'failed') return { status: 'failed', providerRef: c.ref, reason: 'declined' };
    return { status: 'pending', providerRef: c.ref };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const r = this.gateway.refund(req.idempotencyKey, req.providerRef, req.amount);
    return 'error' in r ? { status: 'failed', reason: r.error } : { status: 'succeeded', refundRef: r.refundRef };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = header(headers, SIGNATURE_HEADER) ?? '';
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=', 2) as [string, string]));
    const at = Number(parts.t);
    if (!Number.isInteger(at) || Math.abs(Date.now() / 1000 - at) > WEBHOOK_TOLERANCE_S) return null;
    const expected = Buffer.from(signWebhook(this.webhookSecret, rawBody, at).split('v1=')[1]!, 'hex');
    const given = Buffer.from(/^[0-9a-f]{64}$/.test(parts.v1 ?? '') ? parts.v1! : '', 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      return this.parseWebhook(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return null;
    }
  }
}
