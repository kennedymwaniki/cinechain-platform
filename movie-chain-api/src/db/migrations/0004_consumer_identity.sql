-- run-as: migrator
-- Consumer credentials. All platform-level, all on the identity connection.
ALTER TABLE platform.consumer
  ADD COLUMN password_hash   text,                     -- NULL for Google-only accounts
  ADD COLUMN session_version int NOT NULL DEFAULT 1,
  ADD COLUMN last_login_at   timestamptz;

-- External identities (Google today). One person may have several.
CREATE TABLE platform.consumer_identity (
  provider    text NOT NULL CHECK (provider IN ('google')),
  subject     text NOT NULL,                           -- the provider's stable user id
  consumer_id uuid NOT NULL REFERENCES platform.consumer(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX consumer_identity_consumer_idx ON platform.consumer_identity (consumer_id);

-- Single-use e-mail verification tokens, hashed at rest.
CREATE TABLE platform.email_verification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id uuid NOT NULL REFERENCES platform.consumer(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Identity-plane outbox: written in the SAME transaction as the change it
-- announces. `consumer.verified` drives guest-history linking (step 18).
CREATE TABLE platform.identity_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX identity_outbox_pending_idx ON platform.identity_outbox (id) WHERE processed_at IS NULL;

GRANT SELECT, INSERT, UPDATE         ON platform.consumer_identity  TO cinechain_identity;
GRANT SELECT, INSERT, UPDATE         ON platform.email_verification TO cinechain_identity;
GRANT SELECT, INSERT, UPDATE         ON platform.identity_outbox    TO cinechain_identity;
GRANT USAGE ON SEQUENCE platform.identity_outbox_id_seq TO cinechain_identity;
