-- run-as: migrator
-- Tenant-scoped audit trail. Written in the SAME transaction as the change it
-- records, so an audited change and its audit row commit or roll back together.
CREATE TABLE audit_event (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('staff','consumer','guest','system')),
  actor_id      text,
  action        text NOT NULL,                 -- e.g. 'theatre.created'
  resource_type text NOT NULL,
  resource_id   text,
  detail        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_event_resource_idx ON audit_event (tenant_id, resource_type, resource_id, occurred_at DESC);

-- Idempotency keys, per tenant and per endpoint. A replay returns the stored
-- response without re-executing the handler.
CREATE TABLE idempotency_key (
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, key, endpoint)
);
CREATE INDEX idempotency_key_expiry_idx ON idempotency_key (tenant_id, expires_at);
