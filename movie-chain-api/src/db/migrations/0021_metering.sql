-- run-as: migrator
-- Step 24: per-tenant consumption, the input to billing (step 26) and to
-- cost-per-tenant. The plan calls this 0014; numbering here is sequential.
--
-- Control-plane owned and OUTSIDE the application RLS loop: it lives in
-- platform.* (already exempt), cinechain_app has no grant on it at all, and
-- the role that writes it (cinechain_control) has no grant on booking,
-- ticket or payment. Counts only: nothing here identifies a booking or a person.
CREATE TABLE platform.metering_usage (
  tenant_id     uuid   NOT NULL REFERENCES public.tenant (id) ON DELETE CASCADE,
  period        char(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- YYYY-MM, UTC
  requests      bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),        -- object storage under t/<tenant_id>/, at last measurement
  hold_seconds  bigint NOT NULL DEFAULT 0 CHECK (hold_seconds >= 0),         -- seats × seconds reserved
  bookings      bigint NOT NULL DEFAULT 0 CHECK (bookings >= 0),
  tickets       bigint NOT NULL DEFAULT 0 CHECK (tickets >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);
GRANT SELECT, INSERT, UPDATE ON platform.metering_usage TO cinechain_control;
