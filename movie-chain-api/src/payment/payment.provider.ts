import type { Money } from '../shared/money';

/**
 * Provider-agnostic payments (FR-50). One interface, three verbs. Every call
 * carries OUR idempotency key (the booking id), so a retry is never a second
 * charge, and a timeout is resolved by asking `status`, never by capturing again.
 */
export type PaymentMethod =
  | { kind: 'mpesa'; phone: string }
  | { kind: 'card'; cardToken: string } // from provider-hosted fields: never a PAN
  | { kind: 'cash' };

export interface CaptureRequest {
  idempotencyKey: string;
  amount: Money;
  method: PaymentMethod;
  description: string;
}

export type CaptureResult =
  | { status: 'captured'; providerRef: string; capturedAt: Date; cardLast4?: string }
  | { status: 'failed'; providerRef: string | null; reason: string }
  /** Timed out or not yet decided. Resolve with status(); NEVER re-capture. */
  | { status: 'pending'; providerRef: string | null };

export interface RefundRequest {
  idempotencyKey: string;
  providerRef: string;
  amount: Money;
}

export type RefundResult = { status: 'succeeded' | 'pending'; refundRef: string } | { status: 'failed'; reason: string };

/** A webhook, once its signature has been verified. */
export interface WebhookEvent {
  eventId: string;
  providerRef: string;
  status: 'captured' | 'failed';
  reason?: string;
}

export abstract class PaymentProvider {
  abstract readonly name: 'mpesa' | 'card' | 'cash';
  abstract capture(req: CaptureRequest): Promise<CaptureResult>;
  /** Looks a charge up by OUR idempotency key. */
  abstract status(idempotencyKey: string): Promise<CaptureResult | null>;
  abstract refund(req: RefundRequest): Promise<RefundResult>;
  /** Returns null for a bad or stale signature. Must be constant-time. */
  abstract verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
}
