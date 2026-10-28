import { char, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors 0001_registry.sql. The SQL migrations are the source of truth. */
export const tenantTier = pgEnum('tenant_tier', ['basic', 'standard', 'premium', 'dedicated']);
export const tenantStatus = pgEnum('tenant_status', ['pending', 'provisioning', 'active', 'suspended', 'offboarding']);

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tier: tenantTier('tier').notNull().default('basic'),
  status: tenantStatus('status').notNull().default('pending'),
  country: char('country', { length: 2 }).notNull().default('KE'),
  dbRef: text('db_ref'),
  holdSeconds: integer('hold_seconds').notNull().default(300),
  maxSeatsPerBooking: integer('max_seats_per_booking').notNull().default(10),
  currency: char('currency', { length: 3 }).notNull().default('KES'),
  /** The chain's DEFAULT cleaning time, used when a screen has none of its own. Min 60. */
  turnaroundMinutes: integer('turnaround_minutes').notNull().default(60),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenant.$inferSelect;
