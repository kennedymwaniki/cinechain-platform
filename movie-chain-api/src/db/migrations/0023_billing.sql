-- run-as: migrator
-- Step 26: billing. Metering becomes money. The plan calls this 0015.
--
-- Control-plane owned, in platform.* (outside the RLS loop; cinechain_app has
-- no grant on any of it). Money is integer minor units with a currency,
-- everywhere: there is no numeric/float column in this file.

-- What a tenant buys: a base price for a tier, allowances, and overage rates.
CREATE TABLE platform.plan (
  code                        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_-]{1,40}$'),
  tier                        text NOT NULL REFERENCES public.tier (code),
  name                        text NOT NULL,
  currency                    char(3) NOT NULL,
  base_price_minor            bigint NOT NULL CHECK (base_price_minor >= 0),
  -- allowances per period (metering units)
  included_requests           bigint NOT NULL DEFAULT 0 CHECK (included_requests >= 0),
  included_bookings           bigint NOT NULL DEFAULT 0 CHECK (included_bookings >= 0),
  included_tickets            bigint NOT NULL DEFAULT 0 CHECK (included_tickets >= 0),
  included_hold_seconds       bigint NOT NULL DEFAULT 0 CHECK (included_hold_seconds >= 0),
  included_storage_bytes      bigint NOT NULL DEFAULT 0 CHECK (included_storage_bytes >= 0),
  -- overage: price per UNIT, where a unit is `*_unit` of the metered quantity (rounded up)
  overage_requests_unit       bigint NOT NULL DEFAULT 1000 CHECK (overage_requests_unit > 0),
  overage_requests_minor      bigint NOT NULL DEFAULT 0 CHECK (overage_requests_minor >= 0),
  overage_bookings_unit       bigint NOT NULL DEFAULT 1 CHECK (overage_bookings_unit > 0),
  overage_bookings_minor      bigint NOT NULL DEFAULT 0 CHECK (overage_bookings_minor >= 0),
  overage_tickets_unit        bigint NOT NULL DEFAULT 1 CHECK (overage_tickets_unit > 0),
  overage_tickets_minor       bigint NOT NULL DEFAULT 0 CHECK (overage_tickets_minor >= 0),
  overage_hold_seconds_unit   bigint NOT NULL DEFAULT 3600 CHECK (overage_hold_seconds_unit > 0),
  overage_hold_seconds_minor  bigint NOT NULL DEFAULT 0 CHECK (overage_hold_seconds_minor >= 0),
  overage_storage_bytes_unit  bigint NOT NULL DEFAULT 1073741824 CHECK (overage_storage_bytes_unit > 0),  -- per GiB
  overage_storage_bytes_minor bigint NOT NULL DEFAULT 0 CHECK (overage_storage_bytes_minor >= 0),
  active                      boolean NOT NULL DEFAULT true
);

INSERT INTO platform.plan (code, tier, name, currency, base_price_minor,
  included_requests, included_bookings, included_tickets, included_hold_seconds, included_storage_bytes,
  overage_requests_minor, overage_bookings_minor, overage_tickets_minor, overage_hold_seconds_minor, overage_storage_bytes_minor) VALUES
  ('basic-kes',     'basic',     'Basic (KES)',      'KES',  1500000,   1000000,   2000,   5000,   2000000,  5368709120,  50, 2000, 1000, 200, 5000),
  ('standard-kes',  'standard',  'Standard (KES)',   'KES',  4500000,   5000000,  10000,  25000,  10000000, 21474836480,  40, 1500,  800, 150, 4000),
  ('premium-kes',   'premium',   'Premium (KES)',    'KES', 15000000,  25000000,  50000, 125000,  50000000, 107374182400, 30, 1000,  500, 100, 3000),
  ('dedicated-kes', 'dedicated', 'Dedicated (KES)',  'KES', 60000000, 100000000, 250000, 600000, 250000000, 536870912000, 20,  500,  300,  50, 2000);

CREATE TABLE platform.subscription (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenant (id) ON DELETE CASCADE,
  plan_code             text NOT NULL REFERENCES platform.plan (code),
  status                text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled')),
  trial_ends_at         timestamptz,
  grace_days            int NOT NULL DEFAULT 14 CHECK (grace_days BETWEEN 0 AND 90),
  -- the subscription's OWN payment method, with the platform's billing provider (never a ticket payment)
  payment_method_ref    text,
  past_due_since        timestamptz,
  suspended_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- one live subscription per tenant
CREATE UNIQUE INDEX subscription_live_idx ON platform.subscription (tenant_id) WHERE status <> 'cancelled';

CREATE TABLE platform.invoice (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,                        -- CC-2026-11-000123
  tenant_id        uuid NOT NULL REFERENCES public.tenant (id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES platform.subscription (id) ON DELETE CASCADE,
  period           char(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  plan_code        text NOT NULL REFERENCES platform.plan (code),
  currency         char(3) NOT NULL,
  total_minor      bigint NOT NULL CHECK (total_minor >= 0),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void', 'uncollectible')),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz NOT NULL,
  paid_at          timestamptz,
  UNIQUE (tenant_id, period)                                    -- closing a period twice issues nothing new
);

-- Every line carries its own arithmetic, and the database checks it:
--   billable_units = ceil(max(metered - included, 0) / unit_size)
--   amount_minor   = billable_units × unit_price_minor
-- `metered_quantity` is copied from platform.metering_usage at issue time;
-- reconciliation compares the two.
CREATE TABLE platform.invoice_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES platform.invoice (id) ON DELETE CASCADE,
  position          int NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('base', 'requests', 'bookings', 'tickets', 'hold_seconds', 'storage_bytes', 'trial_credit')),
  description       text NOT NULL,
  metered_quantity  bigint NOT NULL CHECK (metered_quantity >= 0),
  included_quantity bigint NOT NULL CHECK (included_quantity >= 0),
  unit_size         bigint NOT NULL CHECK (unit_size > 0),
  billable_units    bigint NOT NULL CHECK (billable_units >= 0),
  unit_price_minor  bigint NOT NULL,                               -- negative only for a credit
  amount_minor      bigint NOT NULL,
  UNIQUE (invoice_id, position),
  CHECK (kind IN ('base', 'trial_credit') OR billable_units = (greatest(metered_quantity - included_quantity, 0) + unit_size - 1) / unit_size),
  CHECK (amount_minor = billable_units * unit_price_minor),
  CHECK (kind = 'trial_credit' OR unit_price_minor >= 0)
);

-- Subscription payments: the platform's OWN provider account and idempotency
-- namespace ('sub:<invoice>:<attempt>'), never the ticket payment path.
CREATE TABLE platform.subscription_payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES platform.invoice (id) ON DELETE CASCADE,
  attempt          int NOT NULL CHECK (attempt >= 1),
  idempotency_key  text NOT NULL UNIQUE CHECK (idempotency_key LIKE 'sub:%'),
  status           text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  provider_ref     text,
  failure_reason   text,
  attempted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, attempt)
);

-- Dunning notices, one per stage per invoice (idempotent).
CREATE TABLE platform.dunning_notice (
  invoice_id  uuid NOT NULL REFERENCES platform.invoice (id) ON DELETE CASCADE,
  stage       text NOT NULL CHECK (stage IN ('payment_failed', 'retry_scheduled', 'final_notice', 'suspended', 'reactivated')),
  attempt     int NOT NULL DEFAULT 0,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, stage, attempt)
);

-- The infrastructure bill for a period (input), and its apportionment (output).
CREATE TABLE platform.infra_cost (
  period       char(7) PRIMARY KEY CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency     char(3) NOT NULL,
  total_minor  bigint NOT NULL CHECK (total_minor >= 0),
  source       text NOT NULL,                                      -- e.g. 'cloud invoice 2026-10'
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.tenant_cost_allocation (
  period          char(7) NOT NULL REFERENCES platform.infra_cost (period) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES public.tenant (id) ON DELETE CASCADE,
  currency        char(3) NOT NULL,
  allocated_minor bigint NOT NULL CHECK (allocated_minor >= 0),
  share_ppm       int NOT NULL CHECK (share_ppm BETWEEN 0 AND 1000000),  -- parts per million: an integer share
  drivers         jsonb NOT NULL,                                        -- the consumption that produced the share
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, tenant_id)
);

CREATE SEQUENCE platform.invoice_number_seq;

GRANT SELECT, INSERT, UPDATE ON platform.plan, platform.subscription, platform.invoice, platform.invoice_line,
  platform.subscription_payment, platform.dunning_notice, platform.infra_cost, platform.tenant_cost_allocation TO cinechain_control;
GRANT DELETE ON platform.tenant_cost_allocation TO cinechain_control;  -- recomputing a period's allocation replaces it
GRANT USAGE ON SEQUENCE platform.invoice_number_seq TO cinechain_control;
