import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { payment, type PaymentProviderName, paymentWebhookEvent, type TenderType } from '../db/schema/payment';
import { currentTenant, db } from '../tenancy/tenant-context';

/** Tenant-scoped (RLS). State transitions are conditional updates: a payment leaves `pending` once. */
@Injectable()
export class PaymentRepository {
  /** Idempotent on (tenant, idempotency_key): a retry gets the row the first attempt created. */
  async insertPending(v: {
    bookingId: string;
    provider: PaymentProviderName;
    tenderType: TenderType;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
    cardToken?: string | null;
    recordedByStaff?: string | null;
  }) {
    await db()
      .insert(payment)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .onConflictDoNothing();
    return (await this.byIdempotencyKey(v.idempotencyKey))!;
  }

  async byIdempotencyKey(key: string) {
    const [row] = await db().select().from(payment).where(eq(payment.idempotencyKey, key));
    return row ?? null;
  }

  async byId(id: string) {
    const [row] = await db().select().from(payment).where(eq(payment.id, id));
    return row ?? null;
  }

  async setProviderRef(id: string, providerRef: string) {
    await db().update(payment).set({ providerRef }).where(eq(payment.id, id));
  }

  async markCaptured(id: string, v: { providerRef: string; capturedAt: Date; cardLast4?: string | undefined }) {
    const [row] = await db()
      .update(payment)
      .set({ status: 'captured', providerRef: v.providerRef, capturedAt: v.capturedAt, ...(v.cardLast4 ? { cardLast4: v.cardLast4 } : {}) })
      .where(and(eq(payment.id, id), eq(payment.status, 'pending')))
      .returning();
    return row ?? null;
  }

  async markFailed(id: string, v: { providerRef: string | null; reason: string }) {
    const [row] = await db()
      .update(payment)
      .set({ status: 'failed', failureReason: v.reason, ...(v.providerRef ? { providerRef: v.providerRef } : {}) })
      .where(and(eq(payment.id, id), eq(payment.status, 'pending')))
      .returning();
    return row ?? null;
  }

  /** Replay safety: the first delivery of an event inserts; any re-delivery inserts nothing. */
  async recordWebhookEvent(v: { provider: string; eventId: string; paymentId: string; status: string }): Promise<boolean> {
    const rows = await db()
      .insert(paymentWebhookEvent)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .onConflictDoNothing()
      .returning({ eventId: paymentWebhookEvent.eventId });
    return rows.length === 1;
  }
}
