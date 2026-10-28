import { sql } from 'drizzle-orm';
import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const SCREENING_STATUSES = ['draft', 'published', 'closed', 'completed', 'cancelled'] as const;
export type ScreeningStatus = (typeof SCREENING_STATUSES)[number];
export const screeningStatus = pgEnum('screening_status', SCREENING_STATUSES);

export const screening = pgTable('screening', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  screenId: uuid('screen_id').notNull(),
  filmId: uuid('film_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  turnaroundMinutes: integer('turnaround_minutes').notNull(),
  /** Set by trigger (ends_at + turnaround). Never written by the application. */
  // Omitted from INSERTs (a "default" here only tells Drizzle not to send it);
  // NOT NULL is checked after the BEFORE trigger has filled it in.
  blockedUntil: timestamp('blocked_until', { withTimezone: true }).notNull().default(sql`now()`),
  format: text('format').notNull(),
  status: screeningStatus('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Screening = typeof screening.$inferSelect;
