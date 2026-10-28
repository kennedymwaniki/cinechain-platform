import { bigint, char, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors 0016_payments.sql. */
export const paymentStatus = pgEnum('payment_status', ['pending', 'captured', 'failed']);
export const PAYMENT_PROVIDERS = ['mpesa', 'card', 'cash'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];
export const TENDER_TYPES = ['online', 'cash', 'card_terminal', 'mpesa_till'] as const;
export type TenderType = (typeof TENDER_TYPES)[number];

export const payment = pgTable('payment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  bookingId: uuid('booking_id').notNull(),
  provider: text('provider', { enum: PAYMENT_PROVIDERS }).notNull(),
  tenderType: text('tender_type', { enum: TENDER_TYPES }).notNull().default('online'),
  providerRef: text('provider_ref'),
  idempotencyKey: text('idempotency_key').notNull(),
  status: paymentStatus('status').notNull().default('pending'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  cardToken: text('card_token'),
  cardLast4: char('card_last4', { length: 4 }),
  recordedByStaff: uuid('recorded_by_staff'),
  failureReason: text('failure_reason'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentRefund = pgTable('payment_refund', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reason: text('reason').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status', { enum: ['pending', 'succeeded', 'failed'] }).notNull().default('pending'),
  providerRef: text('provider_ref'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentWebhookEvent = pgTable(
  'payment_webhook_event',
  {
    tenantId: uuid('tenant_id').notNull(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    status: text('status').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.provider, t.eventId] })],
);

export type Payment = typeof payment.$inferSelect;
export type PaymentRefund = typeof paymentRefund.$inferSelect;
