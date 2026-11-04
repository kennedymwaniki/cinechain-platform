import { bigint, boolean, char, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext } from './types';

/**
 * OUTSIDE the tenant boundary. Reachable only on the cinechain_identity
 * connection, through src/identity/ (step 6). cinechain_app has no USAGE on
 * this schema, so a stray query from tenant code fails with permission denied.
 */
export const platform = pgSchema('platform');

export const consumer = platform.table('consumer', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  phone: text('phone'),
  displayName: text('display_name'),
  emailVerified: boolean('email_verified').notNull().default(false),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Never select this into a DTO. */
  passwordHash: text('password_hash'),
  sessionVersion: integer('session_version').notNull().default(1),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export type Consumer = typeof consumer.$inferSelect;

export const refreshToken = platform.table('refresh_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  familyId: uuid('family_id').notNull(),
  audience: text('audience', { enum: ['staff-v1', 'consumer-v1', 'control-v1'] }).notNull(),
  subjectId: uuid('subject_id').notNull(),
  tenantId: uuid('tenant_id'),
  sessionVersion: integer('session_version').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const securityEvent = platform.table('security_event', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  tenantId: uuid('tenant_id'),
  actorSub: text('actor_sub'),
  path: text('path'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
});

export const consumerIdentity = platform.table(
  'consumer_identity',
  {
    provider: text('provider', { enum: ['google'] }).notNull(),
    subject: text('subject').notNull(),
    consumerId: uuid('consumer_id')
      .notNull()
      .references(() => consumer.id),
    email: citext('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] })],
);

export const emailVerification = platform.table('email_verification', {
  id: uuid('id').primaryKey().defaultRandom(),
  consumerId: uuid('consumer_id')
    .notNull()
    .references(() => consumer.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const identityOutbox = platform.table('identity_outbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

/** Step 24. Counts per tenant per UTC month: nothing that identifies a booking or a person. */
export const meteringUsage = platform.table(
  'metering_usage',
  {
    tenantId: uuid('tenant_id').notNull(),
    period: char('period', { length: 7 }).notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
    holdSeconds: bigint('hold_seconds', { mode: 'number' }).notNull().default(0),
    bookings: bigint('bookings', { mode: 'number' }).notNull().default(0),
    tickets: bigint('tickets', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })],
);

/** Step 27. The offboarding workflow, one row per tenant. */
export const offboardingRun = platform.table('offboarding_run', {
  tenantId: uuid('tenant_id').primaryKey(),
  status: text('status', { enum: ['offboarding', 'exported', 'deleted'] }).notNull().default('offboarding'),
  requestedBy: uuid('requested_by').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  exportManifest: jsonb('export_manifest'),
  exportVerifiedAt: timestamp('export_verified_at', { withTimezone: true }),
  report: jsonb('report'),
  reportSignature: text('report_signature'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
