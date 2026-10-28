-- run-as: migrator
-- Step 18: hold → booking. The plan calls this 0012; numbering here is sequential.

ALTER TABLE tenant
  -- Reference prefix, e.g. NYT-4471. Per tenant; references are unique per tenant only.
  ADD COLUMN booking_ref_prefix text CHECK (booking_ref_prefix ~ '^[A-Z]{2,5}$'),
  -- FR-78: points per whole currency unit spent; 0 disables loyalty.
  ADD COLUMN loyalty_points_per_unit int NOT NULL DEFAULT 0 CHECK (loyalty_points_per_unit BETWEEN 0 AND 100),
  -- FR-62: customers may cancel up to this long before the start (step 19).
  ADD COLUMN cancellation_window_minutes int NOT NULL DEFAULT 120 CHECK (cancellation_window_minutes BETWEEN 0 AND 10080);

CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'expired', 'cancelled');

CREATE TABLE booking (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  reference      text NOT NULL,
  screening_id   uuid NOT NULL,
  hold_id        uuid NOT NULL,
  status         booking_status NOT NULL DEFAULT 'pending',
  channel        text NOT NULL CHECK (channel IN ('online', 'box_office')),
  consumer_id    uuid,                 -- NULL for a guest: guest checkout is the primary path (FR-70)
  -- FR-77 inline link: a VERIFIED consumer booking under their own account e-mail.
  -- Decided at checkout (the identity plane is asked then) and applied when the sale commits.
  links_customer boolean NOT NULL DEFAULT false,
  guest_email    citext,               -- the contact for every online booking, guest or not
  guest_name     text,
  guest_phone    text,
  seat_ids       uuid[] NOT NULL,
  total_minor    bigint NOT NULL CHECK (total_minor >= 0),
  currency       char(3) NOT NULL,
  sold_by_staff  uuid,                 -- box-office sales: the clerk (FR-57)
  failure_reason text,
  confirmed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  -- A walk-in at the counter may give no contact; an online booking always does.
  CHECK (channel = 'box_office' OR (guest_email IS NOT NULL AND guest_name IS NOT NULL)),
  FOREIGN KEY (tenant_id, screening_id) REFERENCES screening (tenant_id, id) ON DELETE RESTRICT
);
-- One LIVE booking per hold. A booking whose payment failed is 'expired', so
-- the customer can try again on the same hold with another method.
CREATE UNIQUE INDEX booking_hold_live_idx ON booking (tenant_id, hold_id) WHERE status <> 'expired';
CREATE INDEX booking_guest_idx ON booking (tenant_id, guest_email, created_at DESC);
-- THE one deliberate exception to convention 7: FR-76 is scoped by person,
-- not by tenant. Read only through the consumer_booking_refs door.
CREATE INDEX booking_consumer_idx ON booking (consumer_id, created_at DESC) WHERE consumer_id IS NOT NULL;
CREATE INDEX booking_screening_idx ON booking (tenant_id, screening_id) WHERE status = 'confirmed';

ALTER TABLE payment   ADD FOREIGN KEY (tenant_id, booking_id) REFERENCES booking (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE seat_lock ADD FOREIGN KEY (tenant_id, booking_id) REFERENCES booking (tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE ticket (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  booking_id   uuid NOT NULL,
  screening_id uuid NOT NULL,
  seat_id      uuid NOT NULL,
  -- The code itself is never stored (FR-72): only its hash.
  code_hash    bytea NOT NULL,
  price_minor  bigint NOT NULL CHECK (price_minor >= 0),   -- captured at purchase (FR-27)
  currency     char(3) NOT NULL,
  status       text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'redeemed', 'void')),
  redeemed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code_hash),
  FOREIGN KEY (tenant_id, booking_id)   REFERENCES booking (tenant_id, id)   ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, screening_id) REFERENCES screening (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, seat_id)      REFERENCES seat (tenant_id, id)      ON DELETE RESTRICT
);
-- A seat is admitted on at most one live ticket per screening.
CREATE UNIQUE INDEX ticket_seat_live_idx ON ticket (tenant_id, screening_id, seat_id) WHERE status <> 'void';
CREATE INDEX ticket_booking_idx ON ticket (tenant_id, booking_id);

-- FR-78: per-chain loyalty. Keyed on the booking, so a replay never awards twice.
CREATE TABLE loyalty_ledger (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  booking_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('award', 'reversal')),
  email       citext NOT NULL,
  points      int NOT NULL,           -- negative for a reversal
  shortfall   int NOT NULL DEFAULT 0 CHECK (shortfall >= 0),  -- points already spent when reversed: recorded, not clawed
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, booking_id, kind),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES booking (tenant_id, id) ON DELETE RESTRICT
);

-- Transactional outbox: events and jobs written in the SAME transaction as
-- the change, drained only after COMMIT. Emitting from inside would
-- broadcast a sale that later rolled back.
CREATE TABLE outbox_event (
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  id           bigint GENERATED ALWAYS AS IDENTITY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_event_pending_idx ON outbox_event (tenant_id, id) WHERE processed_at IS NULL;

-- Door 4 (FR-76). "My bookings at every chain" cannot be one RLS-scoped
-- query. Returns POINTERS only — no amounts, no names, no seats. The caller
-- then reads each tenant's rows in that tenant's own scope, under RLS.
CREATE FUNCTION consumer_booking_refs(p_consumer uuid, p_before timestamptz, p_limit int)
RETURNS TABLE (tenant_id uuid, booking_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT b.tenant_id, b.id, b.created_at FROM booking b
   WHERE b.consumer_id = p_consumer AND b.created_at < p_before
   ORDER BY b.created_at DESC LIMIT least(greatest(p_limit, 1), 50);
$$;

-- Door 5 (FR-77). Which chains hold guest purchases under this e-mail that
-- are not yet linked to an account. Tenant ids only. Called solely for a
-- VERIFIED e-mail, from the consumer.verified event.
CREATE FUNCTION tenants_with_unlinked_guest(p_email citext)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT c.tenant_id FROM tenant_customer c WHERE c.email = p_email AND c.consumer_id IS NULL;
$$;

GRANT SELECT (id, tenant_id, consumer_id, created_at) ON booking         TO cinechain_resolver;
GRANT SELECT (tenant_id, email, consumer_id)          ON tenant_customer TO cinechain_resolver;
ALTER FUNCTION consumer_booking_refs(uuid, timestamptz, int) OWNER TO cinechain_resolver;
ALTER FUNCTION tenants_with_unlinked_guest(citext)            OWNER TO cinechain_resolver;
REVOKE ALL ON FUNCTION consumer_booking_refs(uuid, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenants_with_unlinked_guest(citext)            FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consumer_booking_refs(uuid, timestamptz, int) TO cinechain_app;
GRANT EXECUTE ON FUNCTION tenants_with_unlinked_guest(citext)            TO cinechain_app;
