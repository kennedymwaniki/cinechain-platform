import { bigint, boolean, char, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors 0023_billing.sql. Control plane only; money is integer minor units. */
const platform = pgSchema('platform');
const minor = (name: string) => bigint(name, { mode: 'number' });

export const plan = platform.table('plan', {
  code: text('code').primaryKey(),
  tier: text('tier').notNull(),
  name: text('name').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  basePriceMinor: minor('base_price_minor').notNull(),
  includedRequests: minor('included_requests').notNull(),
  includedBookings: minor('included_bookings').notNull(),
  includedTickets: minor('included_tickets').notNull(),
  includedHoldSeconds: minor('included_hold_seconds').notNull(),
  includedStorageBytes: minor('included_storage_bytes').notNull(),
  overageRequestsUnit: minor('overage_requests_unit').notNull(),
  overageRequestsMinor: minor('overage_requests_minor').notNull(),
  overageBookingsUnit: minor('overage_bookings_unit').notNull(),
  overageBookingsMinor: minor('overage_bookings_minor').notNull(),
  overageTicketsUnit: minor('overage_tickets_unit').notNull(),
  overageTicketsMinor: minor('overage_tickets_minor').notNull(),
  overageHoldSecondsUnit: minor('overage_hold_seconds_unit').notNull(),
  overageHoldSecondsMinor: minor('overage_hold_seconds_minor').notNull(),
  overageStorageBytesUnit: minor('overage_storage_bytes_unit').notNull(),
  overageStorageBytesMinor: minor('overage_storage_bytes_minor').notNull(),
  active: boolean('active').notNull(),
});

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscription = platform.table('subscription', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  planCode: text('plan_code').notNull(),
  status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull().default('trialing'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  graceDays: integer('grace_days').notNull().default(14),
  paymentMethodRef: text('payment_method_ref'),
  pastDueSince: timestamp('past_due_since', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoice = platform.table('invoice', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: text('number').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  subscriptionId: uuid('subscription_id').notNull(),
  period: char('period', { length: 7 }).notNull(),
  planCode: text('plan_code').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  totalMinor: minor('total_minor').notNull(),
  status: text('status', { enum: ['open', 'paid', 'void', 'uncollectible'] }).notNull().default('open'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
});

export const LINE_KINDS = ['base', 'requests', 'bookings', 'tickets', 'hold_seconds', 'storage_bytes', 'trial_credit'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const invoiceLine = platform.table('invoice_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull(),
  position: integer('position').notNull(),
  kind: text('kind', { enum: LINE_KINDS }).notNull(),
  description: text('description').notNull(),
  meteredQuantity: minor('metered_quantity').notNull(),
  includedQuantity: minor('included_quantity').notNull(),
  unitSize: minor('unit_size').notNull(),
  billableUnits: minor('billable_units').notNull(),
  unitPriceMinor: minor('unit_price_minor').notNull(),
  amountMinor: minor('amount_minor').notNull(),
});

export const subscriptionPayment = platform.table('subscription_payment', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull(),
  attempt: integer('attempt').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status', { enum: ['succeeded', 'failed'] }).notNull(),
  providerRef: text('provider_ref'),
  failureReason: text('failure_reason'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
});

export const DUNNING_STAGES = ['payment_failed', 'retry_scheduled', 'final_notice', 'suspended', 'reactivated'] as const;
export type DunningStage = (typeof DUNNING_STAGES)[number];

export const dunningNotice = platform.table(
  'dunning_notice',
  {
    invoiceId: uuid('invoice_id').notNull(),
    stage: text('stage', { enum: DUNNING_STAGES }).notNull(),
    attempt: integer('attempt').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.invoiceId, t.stage, t.attempt] })],
);

export const infraCost = platform.table('infra_cost', {
  period: char('period', { length: 7 }).primaryKey(),
  currency: char('currency', { length: 3 }).notNull(),
  totalMinor: minor('total_minor').notNull(),
  source: text('source').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantCostAllocation = platform.table(
  'tenant_cost_allocation',
  {
    period: char('period', { length: 7 }).notNull(),
    tenantId: uuid('tenant_id').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    allocatedMinor: minor('allocated_minor').notNull(),
    sharePpm: integer('share_ppm').notNull(),
    drivers: jsonb('drivers').$type<Record<string, number>>().notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.period, t.tenantId] })],
);

export type Plan = typeof plan.$inferSelect;
export type Subscription = typeof subscription.$inferSelect;
export type Invoice = typeof invoice.$inferSelect;
export type InvoiceLine = typeof invoiceLine.$inferSelect;
