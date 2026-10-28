-- run-as: migrator
-- Step 9: venues. Convention 11 throughout: every parent has UNIQUE (tenant_id, id)
-- and every child references it with a COMPOSITE foreign key, because FK checks
-- bypass RLS — a single-column FK would accept another chain's theatre id.

CREATE TABLE theatre (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  city          text NOT NULL CHECK (length(city) BETWEEN 1 AND 80),
  address       text,
  -- "the 20:30 showing" is a local-time concept, and a chain may cross zones
  timezone      text NOT NULL DEFAULT 'Africa/Nairobi',
  contact_phone text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),          -- names unique WITHIN a chain, never globally
  UNIQUE (tenant_id, id)
);
CREATE INDEX theatre_city_idx ON theatre (tenant_id, lower(city));

CREATE TABLE screen (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  theatre_id            uuid NOT NULL,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  format                text NOT NULL DEFAULT 'standard'
                          CHECK (format IN ('standard','imax','3d','4dx','vip')),
  -- FR-15: temporarily out of service
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','out_of_service')),
  out_of_service_reason text,
  out_of_service_until  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, theatre_id, name),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, theatre_id) REFERENCES theatre (tenant_id, id) ON DELETE RESTRICT,
  CHECK (status = 'active' OR out_of_service_reason IS NOT NULL)
);

-- A physical seat: furniture, independent of any screening.
CREATE TABLE seat (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  screen_id   uuid NOT NULL,
  row_label   text NOT NULL CHECK (row_label ~ '^[A-Z]{1,2}$'),
  seat_number int  NOT NULL CHECK (seat_number BETWEEN 1 AND 200),
  row_index   int  NOT NULL CHECK (row_index >= 0),   -- geometry: the seat map is drawn from these
  col_index   int  NOT NULL CHECK (col_index >= 0),
  seat_class  text NOT NULL DEFAULT 'standard'
                CHECK (seat_class IN ('standard','vip','accessible','companion')),
  is_active   boolean NOT NULL DEFAULT true,          -- false = removed / broken
  UNIQUE (tenant_id, screen_id, row_label, seat_number),
  UNIQUE (tenant_id, screen_id, row_index, col_index),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, screen_id) REFERENCES screen (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX seat_screen_active_idx ON seat (tenant_id, screen_id) WHERE is_active;

-- Theatre scoping for theatre_manager / box_office (FR-5). No rows = whole chain.
CREATE TABLE staff_theatre (
  tenant_id     uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  theatre_id    uuid NOT NULL,
  PRIMARY KEY (tenant_id, staff_user_id, theatre_id),
  FOREIGN KEY (tenant_id, staff_user_id) REFERENCES staff_user (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, theatre_id)    REFERENCES theatre (tenant_id, id)    ON DELETE CASCADE
);

-- The control plane seeds a sample theatre during onboarding (FR-3).
-- SELECT is needed for RETURNING and for DELETE ... WHERE during compensation.
GRANT SELECT, INSERT, DELETE ON theatre, screen, seat TO cinechain_control;
