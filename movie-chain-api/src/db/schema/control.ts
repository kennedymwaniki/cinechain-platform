import { integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { platform } from './platform';
import { citext } from './types';

/** Control-plane tables. Reachable only on the cinechain_control connection. */
export const operator = platform.table('operator', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  displayName: text('display_name'),
  passwordHash: text('password_hash').notNull(),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const onboardingRun = platform.table('onboarding_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  slug: text('slug').notNull(),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(),
  status: text('status', { enum: ['pending', 'provisioning', 'active', 'failed', 'rolled_back'] })
    .notNull()
    .default('pending'),
  error: text('error'),
  requestedBy: uuid('requested_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export interface RecordedResource {
  table: string;
  key: Record<string, string>;
}

export const onboardingStep = platform.table(
  'onboarding_step',
  {
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['pending', 'done', 'compensated'] }).notNull().default('pending'),
    resources: jsonb('resources').$type<RecordedResource[]>().notNull().default([]),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.name] })],
);
