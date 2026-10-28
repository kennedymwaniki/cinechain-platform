-- run-as: migrator
-- Step 17: payments. The plan calls this 0011 (and the PRD lists `payment` in
-- its RLS loop without DDL); numbering here is sequential.

CREATE TYPE payment_status AS ENUM ('pending', 'captured', 'failed');

CREATE TABLE payment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  booking_id      uuid NOT NULL,                -- composite FK added with `booking` (step 18)
  provider        text NOT NULL CHECK (provider IN ('mpesa', 'card', 'cash')),
  -- FR-57: how the money was handed over. Online payments are 'online'.
  tender_type     text NOT NULL DEFAULT 'online' CHECK (tender_type IN ('online', 'cash', 'card_terminal', 'mpesa_till')),
  provider_ref    text,                         -- the provider's id for this charge
  -- Keyed on OUR booking id (FR-51): a retry can never become a second charge.
  idempotency_key text NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        char(3) NOT NULL,
  -- PCI scope SAQ-A: provider-hosted fields only. A token and the last four, never a PAN.
  card_token      text,
  card_last4      char(4) CHECK (card_last4 ~ '^[0-9]{4}$'),
  recorded_by_staff uuid,                       -- the clerk, for box-office tenders
  failure_reason  text,
  captured_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (status <> 'captured' OR captured_at IS NOT NULL)
);
CREATE INDEX payment_booking_idx ON payment (tenant_id, booking_id);
-- Deliberately NOT led by tenant_id: a webhook arrives with only the
-- provider's reference, and this is what the door below looks it up by.
CREATE UNIQUE INDEX payment_provider_ref_idx ON payment (provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE payment_refund (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  payment_id      uuid NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        char(3) NOT NULL,
  reason          text NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX payment_refund_payment_idx ON payment_refund (tenant_id, payment_id);

-- FR-64, enforced by the database: refunds that are not failed can never
-- add up to more than was captured. The payment row is locked first, so two
-- concurrent refunds are checked one after the other.
CREATE FUNCTION payment_refund_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE captured bigint; refunded bigint;
BEGIN
  SELECT CASE WHEN status = 'captured' THEN amount_minor ELSE 0 END INTO captured
    FROM payment WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id FOR UPDATE;
  SELECT coalesce(sum(amount_minor), 0) INTO refunded
    FROM payment_refund WHERE tenant_id = NEW.tenant_id AND payment_id = NEW.payment_id
     AND status <> 'failed' AND id <> NEW.id;
  IF refunded + NEW.amount_minor > coalesce(captured, 0) THEN
    RAISE EXCEPTION 'refund exceeds captured amount' USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_within_capture';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_refund_cap BEFORE INSERT OR UPDATE OF amount_minor, status ON payment_refund
  FOR EACH ROW WHEN (NEW.status <> 'failed') EXECUTE FUNCTION payment_refund_cap();

-- Replay safety for webhooks: one row per provider event. A duplicate
-- delivery inserts nothing and changes nothing.
CREATE TABLE payment_webhook_event (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  provider    text NOT NULL,
  event_id    text NOT NULL,
  payment_id  uuid NOT NULL,
  status      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, event_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id) ON DELETE RESTRICT
);

-- Door 3. A webhook arrives with no session and no tenant: only the
-- provider's reference. Returns the tenant that owns that charge and the
-- payment id — nothing about amount, status or customer. Called only AFTER
-- the webhook's signature has been verified.
CREATE FUNCTION resolve_payment_tenant(p_provider text, p_ref text)
RETURNS TABLE (tenant_id uuid, payment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.tenant_id, p.id FROM payment p WHERE p.provider = p_provider AND p.provider_ref = p_ref;
$$;
GRANT SELECT (id, tenant_id, provider, provider_ref) ON payment TO cinechain_resolver;
ALTER FUNCTION resolve_payment_tenant(text, text) OWNER TO cinechain_resolver;
REVOKE ALL ON FUNCTION resolve_payment_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_payment_tenant(text, text) TO cinechain_app;
