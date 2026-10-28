import { Injectable, Logger } from '@nestjs/common';
import { AuditLog } from '../audit/audit-log.service';
import { notFound, unauthorized } from '../common/errors/api-error';
import { Doors } from '../tenancy/doors';
import { toSystemContext } from '../tenancy/system-context';
import { runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { PaymentProviders } from './payment-providers';
import { PaymentRepository } from './payment.repository';

export type PaymentSettled = { tenantId: string; paymentId: string; bookingId: string; status: 'captured' | 'failed' };

/**
 * FR-56. Webhooks arrive with no session and no tenant. Order matters:
 *   1. verify the signature (and freshness) — nothing else runs for a forgery;
 *   2. find the tenant FROM THE STORED PAYMENT, through a sanctioned door;
 *   3. inside that tenant's scope, record the event id (a re-delivery stops
 *      here) and move the payment out of `pending` at most once.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly log = new Logger(PaymentWebhookService.name);
  private readonly listeners: ((e: PaymentSettled) => Promise<void>)[] = [];

  constructor(
    private readonly providers: PaymentProviders,
    private readonly doors: Doors,
    private readonly tenantDb: TenantDb,
    private readonly repo: PaymentRepository,
    private readonly audit: AuditLog,
  ) {}

  /** Bookings (step 18) subscribe, to confirm or refund what a late callback settles. */
  onSettled(fn: (e: PaymentSettled) => Promise<void>): void {
    this.listeners.push(fn);
  }

  async handle(providerName: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const provider = this.providers.get(providerName);
    if (!provider) throw notFound();
    const event = rawBody ? provider.verifyWebhook(rawBody, headers) : null;
    if (!event) throw unauthorized('invalid_signature', 'Webhook signature is missing, invalid or stale');

    const owner = await this.doors.resolvePaymentTenant(provider.name, event.providerRef);
    if (!owner) {
      // Signed by the provider but not ours (or not yet stored): acknowledge, so it is not retried forever.
      this.log.warn(`${provider.name} webhook for unknown reference ${event.providerRef}`);
      return { received: true };
    }

    const ctx = toSystemContext(owner, { kind: 'system', reason: `${provider.name} webhook` });
    const settled = await runWithTenant(ctx, () =>
      this.tenantDb.withTenantScope(async () => {
        const fresh = await this.repo.recordWebhookEvent({ provider: provider.name, eventId: event.eventId, paymentId: owner.paymentId, status: event.status });
        if (!fresh) return null; // duplicate delivery: no transition
        const row =
          event.status === 'captured'
            ? await this.repo.markCaptured(owner.paymentId, { providerRef: event.providerRef, capturedAt: new Date() })
            : await this.repo.markFailed(owner.paymentId, { providerRef: event.providerRef, reason: event.reason ?? 'failed' });
        await this.audit.record('payment.webhook', 'payment', owner.paymentId, { event_id: event.eventId, status: event.status, transitioned: !!row });
        return row ? { tenantId: owner.tenantId, paymentId: row.id, bookingId: row.bookingId, status: event.status } : null;
      }),
    );
    if (settled) for (const l of this.listeners) await l(settled);
    return { received: true };
  }
}
