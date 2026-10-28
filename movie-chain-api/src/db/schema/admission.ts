import { bigint, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const ADMISSION_RESULTS = ['valid', 'already_used', 'wrong_screening', 'wrong_day', 'void', 'invalid'] as const;
export type AdmissionResult = (typeof ADMISSION_RESULTS)[number];

/** Mirrors 0019_admission.sql. */
export const admissionEvent = pgTable(
  'admission_event',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    ticketId: uuid('ticket_id'),
    screeningId: uuid('screening_id').notNull(),
    result: text('result', { enum: ADMISSION_RESULTS }).notNull(),
    deviceId: text('device_id').notNull(),
    operatorId: uuid('operator_id').notNull(),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
