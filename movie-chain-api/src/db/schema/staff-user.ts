import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant';
import { citext } from './types';

export const STAFF_ROLES = ['box_office', 'theatre_manager', 'chain_admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Tenant-scoped (RLS). UNIQUE (tenant_id, email) — never UNIQUE (email). */
export const staffUser = pgTable(
  'staff_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    email: citext('email').notNull(),
    displayName: text('display_name'),
    role: text('role', { enum: STAFF_ROLES }).notNull(),
    status: text('status', { enum: ['invited', 'active', 'suspended'] }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Never select this into a DTO. Only PasswordService reads it. */
    passwordHash: text('password_hash'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    sessionVersion: integer('session_version').notNull().default(1),
  },
  (t) => [unique().on(t.tenantId, t.email)],
);

export type StaffUser = typeof staffUser.$inferSelect;

export const staffActivation = pgTable('staff_activation', {
  tenantId: uuid('tenant_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  staffUserId: uuid('staff_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
