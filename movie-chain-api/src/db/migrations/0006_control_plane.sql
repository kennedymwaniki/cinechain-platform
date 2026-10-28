-- run-as: migrator
-- ---------------------------------------------------------------------------
-- Control plane. Its own tables live in platform.* (already exempt from the
-- tenant RLS model), so the exemption list does not grow.
-- cinechain_control gets USAGE on platform but NO grant on platform.consumer.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform TO cinechain_control;

CREATE TABLE platform.operator (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  display_name  text,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON platform.operator TO cinechain_control;
GRANT UPDATE (last_login_at) ON platform.operator TO cinechain_control;

CREATE TYPE platform.onboarding_status AS ENUM ('pending','provisioning','active','failed','rolled_back');

CREATE TABLE platform.onboarding_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,           -- generated up front, so the job payload carries it
  slug          text NOT NULL,
  request       jsonb NOT NULL,          -- the validated POST body (no secrets)
  status        platform.onboarding_status NOT NULL DEFAULT 'pending',
  error         text,
  requested_by  uuid NOT NULL,           -- operator id
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
-- At most one live (not failed / rolled back) run per slug.
CREATE UNIQUE INDEX onboarding_run_live_slug ON platform.onboarding_run (slug)
  WHERE status IN ('pending','provisioning','active');
CREATE INDEX onboarding_run_tenant_idx ON platform.onboarding_run (tenant_id, created_at DESC);

-- EVERY created resource is recorded, so a partial onboarding is undone by
-- reading a list rather than guessing.
CREATE TABLE platform.onboarding_step (
  run_id      uuid NOT NULL REFERENCES platform.onboarding_run(id) ON DELETE CASCADE,
  seq         int  NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','compensated')),
  resources   jsonb NOT NULL DEFAULT '[]',   -- [{ "table": "...", "key": { ... } }]
  finished_at timestamptz,
  PRIMARY KEY (run_id, name)
);
GRANT SELECT, INSERT, UPDATE ON platform.onboarding_run, platform.onboarding_step TO cinechain_control;

-- ---------------------------------------------------------------------------
-- Staff activation: the first chain_admin's single-use, 24 h link.
-- ---------------------------------------------------------------------------
ALTER TABLE staff_user ADD CONSTRAINT staff_user_tenant_id_id_key UNIQUE (tenant_id, id);  -- composite FK target

CREATE TABLE staff_activation (
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  token_hash    text NOT NULL,
  staff_user_id uuid NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, token_hash),
  -- convention 11: composite FK, so it cannot point at another tenant's staff
  FOREIGN KEY (tenant_id, staff_user_id) REFERENCES staff_user (tenant_id, id) ON DELETE CASCADE
);

-- The control plane writes exactly these tenant tables during onboarding, and
-- only inside a tenant scope (RLS still applies). Nothing on booking, ticket,
-- payment — those grants must never exist.
GRANT SELECT, INSERT, DELETE ON staff_user, staff_activation TO cinechain_control;
GRANT DELETE ON tenant TO cinechain_control;
