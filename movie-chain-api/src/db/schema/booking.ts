import { bigint, boolean, char, customType, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext } from './types';

/** Mirrors 0017_bookings.sql. */
export const BOOKING_STATUSES = ['pending', 'confirmed', 'expired', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const bookingStatus = pgEnum('booking_status', BOOKING_STATUSES);

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const booking = pgTable('booking', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  reference: text('reference').notNull(),
  screeningId: uuid('screening_id').notNull(),
  holdId: uuid('hold_id').notNull(),
  status: bookingStatus('status').notNull().default('pending'),
  channel: text('channel', { enum: ['online', 'box_office'] }).notNull(),
  consumerId: uuid('consumer_id'),
  linksCustomer: boolean('links_customer').notNull().default(false),
  guestEmail: citext('guest_email'),
  guestName: text('guest_name'),
  guestPhone: text('guest_phone'),
  seatIds: uuid('seat_ids').array().notNull(),
  totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  soldByStaff: uuid('sold_by_staff'),
  failureReason: text('failure_reason'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ticket = pgTable('ticket', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  bookingId: uuid('booking_id').notNull(),
  screeningId: uuid('screening_id').notNull(),
  seatId: uuid('seat_id').notNull(),
  codeHash: bytea('code_hash').notNull(),
  priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status', { enum: ['valid', 'redeemed', 'void'] }).notNull().default('valid'),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const loyaltyLedger = pgTable(
  'loyalty_ledger',
  {
    tenantId: uuid('tenant_id').notNull(),
    bookingId: uuid('booking_id').notNull(),
    kind: text('kind', { enum: ['award', 'reversal'] }).notNull(),
    /** 'award', or the refund id a reversal belongs to. */
    ref: text('ref').notNull().default('award'),
    email: citext('email').notNull(),
    points: integer('points').notNull(),
    shortfall: integer('shortfall').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.bookingId, t.kind, t.ref] })],
);

export const outboxEvent = pgTable(
  'outbox_event',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export type Booking = typeof booking.$inferSelect;
export type Ticket = typeof ticket.$inferSelect;
