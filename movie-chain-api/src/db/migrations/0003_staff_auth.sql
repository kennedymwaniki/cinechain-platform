-- run-as: migrator
ALTER TABLE staff_user
  ADD COLUMN password_hash   text,                       -- argon2id; NULL until the invite is accepted
  ADD COLUMN last_login_at   timestamptz,
  ADD COLUMN session_version int NOT NULL DEFAULT 1;     -- bump to invalidate every session

-- Refresh tokens for EVERY audience (staff, consumer, control). Platform-level:
-- a refresh token is a credential, not tenant data. Reachable only on the
-- cinechain_identity connection.
CREATE TABLE platform.refresh_token (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL,                   -- one login = one family; reuse revokes the family
  audience        text NOT NULL CHECK (audience IN ('staff-v1','consumer-v1','control-v1')),
  subject_id      uuid NOT NULL,
  tenant_id       uuid,                            -- staff only
  session_version int  NOT NULL,
  token_hash      text NOT NULL UNIQUE,            -- sha256 of the opaque token; the token itself is never stored
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,                     -- set when rotated; presenting it again = reuse
  revoked_at      timestamptz,
  CHECK ((audience = 'staff-v1') = (tenant_id IS NOT NULL))
);
CREATE INDEX refresh_token_family_idx ON platform.refresh_token (family_id);
GRANT SELECT, INSERT, UPDATE ON platform.refresh_token TO cinechain_identity;

-- Security events: platform-level, append-only. Written on the identity
-- connection so a tenant can never read (or erase) evidence about itself.
CREATE TABLE platform.security_event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  tenant_id   uuid,
  actor_sub   text,
  path        text,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX security_event_kind_idx ON platform.security_event (kind, occurred_at DESC);
GRANT INSERT ON platform.security_event TO cinechain_identity;
GRANT USAGE ON SEQUENCE platform.security_event_id_seq TO cinechain_identity;
