-- run-as: migrator
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE tenant_tier   AS ENUM ('basic','standard','premium','dedicated');
CREATE TYPE tenant_status AS ENUM ('pending','provisioning','active','suspended','offboarding');

-- THE REGISTRY. No tenant_id. No RLS. Onboarding writes here with NO GUC set.
CREATE TABLE tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  name          text NOT NULL,
  tier          tenant_tier   NOT NULL DEFAULT 'basic',
  status        tenant_status NOT NULL DEFAULT 'pending',
  country       char(2) NOT NULL DEFAULT 'KE',
  db_ref        text,                    -- always NULL for now; the silo hook. No code reads it.
  hold_seconds  int NOT NULL DEFAULT 300 CHECK (hold_seconds BETWEEN 120 AND 900),
  max_seats_per_booking int NOT NULL DEFAULT 10 CHECK (max_seats_per_booking BETWEEN 1 AND 50),
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON tenant TO cinechain_app, cinechain_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant TO cinechain_control;

-- OUTSIDE the tenant boundary. Protected by the GRANT, not by a policy.
CREATE SCHEMA platform AUTHORIZATION cinechain_migrator;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO cinechain_identity;   -- cinechain_app deliberately absent

CREATE TABLE platform.consumer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,     -- one person, one account, globally
  phone          text,
  display_name   text,
  email_verified boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON platform.consumer TO cinechain_identity;
