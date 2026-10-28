import { bigint, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant';

export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: text('actor_kind', { enum: ['staff', 'consumer', 'guest', 'system'] }).notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] }).notNull().default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key, t.endpoint] })],
);
