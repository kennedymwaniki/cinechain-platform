-- run-as: migrator
-- The sweep's FOR UPDATE SKIP LOCKED needs UPDATE privilege on at least one
-- column (Postgres requires it to take a row lock). Grant it on created_at:
-- the one column whose value changes nothing about a hold. The sweeper still
-- cannot touch status, hold_id, expires_at or booking_id.
GRANT UPDATE (created_at) ON seat_lock TO cinechain_sweeper;
