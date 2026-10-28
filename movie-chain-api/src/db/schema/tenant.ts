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
  /** FR-47: 'demand' enforces seat-gap prevention only on busy screenings. */
  seatGapPolicy: text('seat_gap_policy', { enum: ['off', 'demand', 'always'] }).notNull().default('demand'),
  seatGapOccupancyThreshold: integer('seat_gap_occupancy_threshold').notNull().default(60),
  seatGapLiftMinutes: integer('seat_gap_lift_minutes').notNull().default(30),
  bookingRefPrefix: text('booking_ref_prefix'),
  loyaltyPointsPerUnit: integer('loyalty_points_per_unit').notNull().default(0),
  cancellationWindowMinutes: integer('cancellation_window_minutes').notNull().default(120),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenant.$inferSelect;
