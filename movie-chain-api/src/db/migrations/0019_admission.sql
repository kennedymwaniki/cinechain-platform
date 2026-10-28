-- run-as: migrator
-- Step 20: admission. The plan calls this 0013; numbering here is sequential.

-- FR-61: every scan, accepted or not, with time, device and operator. Disputes at the door.
CREATE TABLE admission_event (
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  id           bigint GENERATED ALWAYS AS IDENTITY,
  ticket_id    uuid,                 -- NULL when the code matched no ticket of this chain
  screening_id uuid NOT NULL,        -- the screening being admitted
  result       text NOT NULL CHECK (result IN ('valid', 'already_used', 'wrong_screening', 'wrong_day', 'void', 'invalid')),
  device_id    text NOT NULL,
  operator_id  uuid NOT NULL,        -- the clerk
  scanned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id)    REFERENCES ticket (tenant_id, id)    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, screening_id) REFERENCES screening (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX admission_event_screening_idx ON admission_event (tenant_id, screening_id, scanned_at DESC);

-- Door 6 (FR-73). Reference AND e-mail, both required: the reference alone
-- is an enumeration oracle, so this returns nothing unless the caller
-- already knows both. Pointers only.
CREATE FUNCTION resolve_booking_reference(p_reference text, p_email citext)
RETURNS TABLE (tenant_id uuid, booking_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT b.tenant_id, b.id FROM booking b
   WHERE b.reference = upper(p_reference) AND b.guest_email = p_email
   LIMIT 2;
$$;
GRANT SELECT (reference, guest_email) ON booking TO cinechain_resolver;
ALTER FUNCTION resolve_booking_reference(text, citext) OWNER TO cinechain_resolver;
REVOKE ALL ON FUNCTION resolve_booking_reference(text, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_booking_reference(text, citext) TO cinechain_app;
