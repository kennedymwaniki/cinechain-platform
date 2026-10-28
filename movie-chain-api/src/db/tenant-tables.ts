/**
 * THE list of tenant-scoped tables. Single source of truth for:
 *   - the RLS generator (src/db/sql/rls.sql via db:migrate),
 *   - the schema guard (test/isolation/schema-guard.spec.ts),
 *   - tenant offboarding (step 27).
 * A table that has tenant_id but is missing here fails the schema guard.
 */
export const TENANT_TABLES = [
  'staff_user', // step 3
  'tenant_customer', // step 3
  'audit_event', // step 7
  'idempotency_key', // step 7
  'staff_activation', // step 8
  'theatre', // step 9
  'screen', // step 9
  'seat', // step 9
  'staff_theatre', // step 9
  'film', // step 10
  'pricing_rule', // step 10
  'screening', // step 11
  'seat_lock', // step 12
] as const satisfies readonly string[];

export type TenantTable = (typeof TENANT_TABLES)[number];

/**
 * Tables in `public` deliberately WITHOUT row-level security. This list is
 * complete; extending it is a reviewed change to the schema-guard test.
 */
export const RLS_EXEMPT_TABLES = ['tenant', 'drizzle_migrations'] as const;

/**
 * The sanctioned cross-tenant read doors (SECURITY DEFINER functions owned
 * by cinechain_resolver), reviewed as security code. Adding one is a change
 * to this list, which the schema guard checks against the database.
 */
export const SANCTIONED_DOORS = [
  'public_showtimes', // step 12: cross-chain browsing, poster data only
  'resolve_published_screening', // step 12: guest names a screening → its tenant
] as const satisfies readonly string[];
