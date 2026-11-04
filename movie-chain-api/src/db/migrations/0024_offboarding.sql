-- run-as: migrator
-- Step 27: tenant lifecycle. Suspend, reactivate, offboard (FR-6, FR-8).

-- After offboarding, the registry row stays as a TOMBSTONE: invoices and
-- metering (platform.*) reference it and are kept for accounting. Every
-- tenant-scoped row is gone; this row holds no tenant data.
ALTER TYPE tenant_status ADD VALUE IF NOT EXISTS 'deleted';

-- The offboarding workflow: ACTIVE → OFFBOARDING → EXPORTED → DELETED.
-- One row per tenant; every transition is recorded, so a crash resumes.
CREATE TABLE platform.offboarding_run (
  tenant_id          uuid PRIMARY KEY REFERENCES public.tenant (id),
  status             text NOT NULL DEFAULT 'offboarding' CHECK (status IN ('offboarding', 'exported', 'deleted')),
  requested_by       uuid NOT NULL,                                 -- the operator
  requested_at       timestamptz NOT NULL DEFAULT now(),
  deadline_at        timestamptz NOT NULL,                          -- FR-8: 30 days
  export_manifest    jsonb,                                         -- per table: rows, sha256, object key
  export_verified_at timestamptz,                                   -- re-read from storage and matched BEFORE any deletion
  report             jsonb,                                         -- per-table before/after, Redis, queues, objects
  report_signature   text,                                          -- Ed25519 (control-v1) JWS over the report
  completed_at       timestamptz,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'exported' OR export_verified_at IS NOT NULL),
  CHECK (status <> 'deleted' OR (report IS NOT NULL AND report_signature IS NOT NULL))
);
GRANT SELECT, INSERT, UPDATE ON platform.offboarding_run TO cinechain_control;
