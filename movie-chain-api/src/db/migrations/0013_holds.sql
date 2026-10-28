-- run-as: migrator
-- Steps 13–14: holds. The plan calls this 0010b; numbering here is sequential.

-- FR-47, demand-driven seat-gap prevention. Off below the occupancy threshold
-- and within lift_minutes of the start: a quiet night never blocks a choice.
ALTER TABLE tenant
  ADD COLUMN seat_gap_policy text NOT NULL DEFAULT 'demand'
    CHECK (seat_gap_policy IN ('off', 'demand', 'always')),
  ADD COLUMN seat_gap_occupancy_threshold int NOT NULL DEFAULT 60
    CHECK (seat_gap_occupancy_threshold BETWEEN 0 AND 100),
  ADD COLUMN seat_gap_lift_minutes int NOT NULL DEFAULT 30
    CHECK (seat_gap_lift_minutes BETWEEN 0 AND 1440);

-- FR-45: one extension per hold. FR-48: a box-office hold names its clerk.
ALTER TABLE seat_lock
  ADD COLUMN extensions smallint NOT NULL DEFAULT 0 CHECK (extensions BETWEEN 0 AND 1),
  ADD COLUMN held_by_staff uuid;

-- Release and extend find a hold's rows by hold id.
CREATE INDEX seat_lock_hold_idx ON seat_lock (tenant_id, hold_id) WHERE status = 'held';
