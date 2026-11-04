-- run-as: migrator
-- Step 25: tiers are CONFIGURATION, not code. A tier is a row; a fifth tier is
-- an INSERT (and a pricing page), never a deploy. Nothing in the application
-- branches on a tier's name: it reads these numbers.
--
-- `tier` has no tenant_id: it is global product configuration, like `tenant`.
-- It is the fourth reviewed RLS exemption (RLS_EXEMPT_TABLES, schema guard).
CREATE TABLE tier (
  code                     text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name                     text NOT NULL,
  sort_order               int  NOT NULL DEFAULT 0,
  sellable                 boolean NOT NULL DEFAULT true,
  -- requests per second per tenant, across every API instance (sliding window)
  rate_limit_rps           int  NOT NULL CHECK (rate_limit_rps BETWEEN 1 AND 100000),
  max_theatres             int  NOT NULL CHECK (max_theatres >= 1),
  hold_seconds_min         int  NOT NULL CHECK (hold_seconds_min >= 120),
  hold_seconds_max         int  NOT NULL CHECK (hold_seconds_max <= 900),
  max_seats_per_booking    int  NOT NULL CHECK (max_seats_per_booking BETWEEN 1 AND 50),
  data_retention_days      int  NOT NULL CHECK (data_retention_days >= 30),
  CHECK (hold_seconds_min <= hold_seconds_max)
);

INSERT INTO tier (code, name, sort_order, rate_limit_rps, max_theatres, hold_seconds_min, hold_seconds_max, max_seats_per_booking, data_retention_days) VALUES
  ('basic',     'Basic',       10,  20,    2, 120, 300,  6,  365),
  ('standard',  'Standard',    20,  60,   10, 120, 600, 10,  730),
  ('premium',   'Premium',     30, 200,   50, 120, 900, 20, 1825),
  ('dedicated', 'Dedicated',   40, 600, 1000, 120, 900, 50, 2555);

-- tenant.tier: from a closed enum to a reference to a row.
ALTER TABLE tenant ALTER COLUMN tier DROP DEFAULT;
ALTER TABLE tenant ALTER COLUMN tier TYPE text USING tier::text;
ALTER TABLE tenant ALTER COLUMN tier SET DEFAULT 'basic';
ALTER TABLE tenant ADD CONSTRAINT tenant_tier_fkey FOREIGN KEY (tier) REFERENCES tier (code) ON UPDATE CASCADE;
DROP TYPE tenant_tier;

-- A negotiated per-tenant limit (an enterprise contract), overriding the tier's. NULL = the tier's.
ALTER TABLE tenant ADD COLUMN rate_limit_rps int CHECK (rate_limit_rps IS NULL OR rate_limit_rps BETWEEN 1 AND 100000);

GRANT SELECT ON tier TO cinechain_app, cinechain_identity, cinechain_control;
GRANT INSERT, UPDATE ON tier TO cinechain_control;   -- operators manage the catalogue of tiers
