import { pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

export const lockStatus = pgEnum('lock_status', ['held', 'sold']);

/** One seat at one screening. PRIMARY KEY (screening_id, seat_id) is the guarantee. */
export const seatLock = pgTable(
  'seat_lock',
  {
    screeningId: uuid('screening_id').notNull(),
    seatId: uuid('seat_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    status: lockStatus('status').notNull(),
    holdId: uuid('hold_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    bookingId: uuid('booking_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.screeningId, t.seatId] })],
);

export type SeatLock = typeof seatLock.$inferSelect;
