import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors 0020_report_export.sql. */
export const reportExport = pgTable('report_export', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['revenue', 'occupancy'] }).notNull(),
  fromAt: timestamp('from_at', { withTimezone: true }).notNull(),
  toAt: timestamp('to_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  objectKey: text('object_key'),
  rows: integer('rows'),
  requestedBy: uuid('requested_by').notNull(),
  failure: text('failure'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type ReportExport = typeof reportExport.$inferSelect;
