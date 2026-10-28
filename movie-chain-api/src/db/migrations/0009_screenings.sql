-- run-as: migrator
-- Step 11: screenings, and the database itself refusing overlaps (FR-22).

-- Cleaning and ads between showings: tenant configuration, not a literal.
ALTER TABLE tenant ADD COLUMN turnaround_minutes int NOT NULL DEFAULT 20 CHECK (turnaround_minutes BETWEEN 0 AND 120);

CREATE TYPE screening_status AS ENUM ('draft','published','closed','completed','cancelled');

CREATE TABLE screening (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  screen_id          uuid NOT NULL,
  film_id            uuid NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  -- copied from the tenant at creation, so a later config change never
  -- retroactively makes existing screenings overlap
  turnaround_minutes int NOT NULL CHECK (turnaround_minutes BETWEEN 0 AND 120),
  blocked_until      timestamptz NOT NULL,     -- set by trigger: ends_at + turnaround
  format             text NOT NULL,            -- the screen's format when scheduled
  status             screening_status NOT NULL DEFAULT 'draft',
  published_at       timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, screen_id) REFERENCES screen (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, film_id)   REFERENCES film (tenant_id, id)   ON DELETE RESTRICT,
  CHECK (ends_at > starts_at),
  CHECK (blocked_until >= ends_at)
);

-- The PRD writes the turnaround INTO the exclusion expression. That cannot
-- work: timestamptz + interval is STABLE, not IMMUTABLE, and Postgres refuses
-- it in an index expression. A trigger computes it into a column instead.
CREATE FUNCTION screening_set_blocked_until() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.blocked_until := NEW.ends_at + make_interval(mins => NEW.turnaround_minutes);
  RETURN NEW;
END $$;
CREATE TRIGGER screening_blocked_until
  BEFORE INSERT OR UPDATE OF starts_at, ends_at, turnaround_minutes ON screening
  FOR EACH ROW EXECUTE FUNCTION screening_set_blocked_until();

-- Query-then-insert races (two managers both see no conflict, both insert).
-- The constraint makes the guarantee structural.
ALTER TABLE screening ADD CONSTRAINT no_screen_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    screen_id WITH =,
    tstzrange(starts_at, blocked_until) WITH &&
  ) WHERE (status <> 'cancelled');

CREATE INDEX screening_screen_time_idx ON screening (tenant_id, screen_id, starts_at);
CREATE INDEX screening_published_film_idx ON screening (tenant_id, film_id, starts_at) WHERE status = 'published';
