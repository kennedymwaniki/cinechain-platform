-- run-as: migrator
-- Step 10: each chain's own film catalogue, and effective-dated pricing.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Every price a chain sets is in ITS currency (convention 8).
ALTER TABLE tenant ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES'
  CHECK (currency IN ('KES','UGX','TZS','RWF','USD'));

CREATE TABLE film (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),   -- NOT unique: two chains, one title
  synopsis     text,
  runtime_min  int  NOT NULL CHECK (runtime_min BETWEEN 1 AND 600),
  rating       text CHECK (rating IN ('GE','PG','16','18','R')),         -- KFCB classifications
  language     text,
  release_date date,
  poster_key   text,                                                    -- object key in MinIO, t/<tenant>/…
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX film_title_idx ON film (tenant_id, lower(title));

-- A price per seat class (and optionally per screen format), valid over
-- [effective_from, effective_to). NULL format = every format; NULL end = open.
-- The PRD names pricing_rule in its RLS loop but never gives DDL; this is it.
CREATE TABLE pricing_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  seat_class     text NOT NULL CHECK (seat_class IN ('standard','vip','accessible','companion')),
  format         text CHECK (format IN ('standard','imax','3d','4dx','vip')),
  price_minor    int  NOT NULL CHECK (price_minor >= 0),
  currency       char(3) NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- At any instant, at most ONE rule per (class, format). The database says so.
  CONSTRAINT pricing_rule_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    seat_class WITH =,
    (coalesce(format, '*')) WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);

-- Onboarding seeds a default price list (FR-3).
GRANT SELECT, INSERT, DELETE ON film, pricing_rule TO cinechain_control;
