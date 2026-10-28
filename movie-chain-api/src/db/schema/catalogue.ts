import { char, date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { SCREEN_FORMATS, SEAT_CLASSES } from './venue';

export const FILM_RATINGS = ['GE', 'PG', '16', '18', 'R'] as const;

export const film = pgTable('film', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  synopsis: text('synopsis'),
  runtimeMin: integer('runtime_min').notNull(),
  rating: text('rating', { enum: FILM_RATINGS }),
  language: text('language'),
  releaseDate: date('release_date'),
  posterKey: text('poster_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pricingRule = pgTable('pricing_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  seatClass: text('seat_class', { enum: SEAT_CLASSES }).notNull(),
  format: text('format', { enum: SCREEN_FORMATS }),
  priceMinor: integer('price_minor').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Film = typeof film.$inferSelect;
export type PricingRule = typeof pricingRule.$inferSelect;
