-- run-as: migrator
-- Step 22: asynchronous CSV exports (FR-66). The file lives in object storage
-- under t/<tenant_id>/exports/; this row is its status and its key.
CREATE TABLE report_export (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN ('revenue', 'occupancy')),
  from_at      timestamptz NOT NULL,
  to_at        timestamptz NOT NULL CHECK (to_at > from_at),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  object_key   text CHECK (object_key IS NULL OR object_key LIKE 't/' || tenant_id::text || '/exports/%'),
  rows         int,
  requested_by uuid NOT NULL,
  failure      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX report_export_recent_idx ON report_export (tenant_id, created_at DESC);
