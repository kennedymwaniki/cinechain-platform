-- run-as: migrator
-- Step 19: failure and refund paths.

-- A booking can be refunded in parts (FR-64), and each part reverses its
-- share of the loyalty award. One award per booking; one reversal per refund.
ALTER TABLE loyalty_ledger ADD COLUMN ref text NOT NULL DEFAULT 'award';
ALTER TABLE loyalty_ledger DROP CONSTRAINT loyalty_ledger_pkey;
ALTER TABLE loyalty_ledger ADD PRIMARY KEY (tenant_id, booking_id, kind, ref);

-- Each refund remembers which booking it belongs to and when it was last
-- attempted, so the reconciler can retry the ones still pending.
ALTER TABLE payment_refund
  ADD COLUMN attempted_at timestamptz,
  ADD COLUMN failure_reason text;
CREATE INDEX payment_refund_pending_idx ON payment_refund (tenant_id, created_at) WHERE status = 'pending';

-- The reconciler's other question: captured payments whose booking never confirmed.
CREATE INDEX booking_pending_idx ON booking (tenant_id, created_at) WHERE status = 'pending';

-- Ticket voids (a cancelled seat) are timestamped for the audit trail and reports.
ALTER TABLE ticket ADD COLUMN voided_at timestamptz;
