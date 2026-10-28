import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors 0007_venues.sql. Every FK there is composite (convention 11). */
export const SEAT_CLASSES = ['standard', 'vip', 'accessible', 'companion'] as const;
export type SeatClass = (typeof SEAT_CLASSES)[number];
export const SCREEN_FORMATS = ['standard', 'imax', '3d', '4dx', 'vip'] as const;
export type ScreenFormat = (typeof SCREEN_FORMATS)[number];

export const theatre = pgTable('theatre', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  address: text('address'),
  timezone: text('timezone').notNull().default('Africa/Nairobi'),
  contactPhone: text('contact_phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const screen = pgTable('screen', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  theatreId: uuid('theatre_id').notNull(),
  name: text('name').notNull(),
  format: text('format', { enum: SCREEN_FORMATS }).notNull().default('standard'),
  status: text('status', { enum: ['active', 'out_of_service'] }).notNull().default('active'),
  outOfServiceReason: text('out_of_service_reason'),
  outOfServiceUntil: timestamp('out_of_service_until', { withTimezone: true }),
  /** Cleaning time after each screening on this screen; null = the chain's default. Min 60. */
  turnaroundMinutes: integer('turnaround_minutes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const seat = pgTable('seat', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  screenId: uuid('screen_id').notNull(),
  rowLabel: text('row_label').notNull(),
  seatNumber: integer('seat_number').notNull(),
  rowIndex: integer('row_index').notNull(),
  colIndex: integer('col_index').notNull(),
  seatClass: text('seat_class', { enum: SEAT_CLASSES }).notNull().default('standard'),
  isActive: boolean('is_active').notNull().default(true),
});

export const staffTheatre = pgTable(
  'staff_theatre',
  {
    tenantId: uuid('tenant_id').notNull(),
    staffUserId: uuid('staff_user_id').notNull(),
    theatreId: uuid('theatre_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.staffUserId, t.theatreId] })],
);

export type Theatre = typeof theatre.$inferSelect;
export type Screen = typeof screen.$inferSelect;
export type Seat = typeof seat.$inferSelect;
