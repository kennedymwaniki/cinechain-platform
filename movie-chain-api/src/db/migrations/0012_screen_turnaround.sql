-- run-as: migrator
-- Cleaning time depends on the HALL, not the chain: a 400-seat IMAX hall takes
-- longer than a 60-seat VIP room. Each screen may set its own default.
-- NULL = use the chain's default. The 60-minute floor applies everywhere.
ALTER TABLE screen ADD COLUMN turnaround_minutes int CHECK (turnaround_minutes BETWEEN 60 AND 240);

-- Resolution when a screening is created (ScreeningService.create):
--   the value given for that screening → the screen's default → the chain's default.
-- The result is COPIED onto the screening row, which is what the overlap
-- constraint uses; changing a default never moves a scheduled screening.
