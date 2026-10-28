-- run-as: migrator
-- The first two tenant-scoped tables. Both are added to TENANT_TABLES, which
-- is what gives them RLS; nothing here writes a policy by hand.

-- Staff: tenant-scoped. Unique WITHIN a chain: the same person working for two
-- chains gets two accounts, and that is correct (PRD §4.2).
CREATE TABLE staff_user (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  email        citext NOT NULL,
  display_name text,
  role         text NOT NULL CHECK (role IN ('box_office','theatre_manager','chain_admin')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- What THIS chain knows about a customer, because they transacted with THIS
-- chain. Keyed on e-mail so a guest who later registers can be linked (FR-77).
CREATE TABLE tenant_customer (
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  email          citext NOT NULL,
  consumer_id    uuid,                         -- NULL for guest purchases; never exposed to the tenant
  display_name   text,
  loyalty_points int NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email)
);
CREATE INDEX tenant_customer_consumer_idx ON tenant_customer (tenant_id, consumer_id) WHERE consumer_id IS NOT NULL;
