import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant';
import { citext } from './types';

/**
 * Tenant-scoped (RLS). `consumerId` is an internal join key: never return it
 * from a tenant-facing API (PRD §6.2, FR-79).
 */
export const tenantCustomer = pgTable(
  'tenant_customer',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    email: citext('email').notNull(),
    consumerId: uuid('consumer_id'),
    displayName: text('display_name'),
    loyaltyPoints: integer('loyalty_points').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.email] })],
);

export type TenantCustomer = typeof tenantCustomer.$inferSelect;
