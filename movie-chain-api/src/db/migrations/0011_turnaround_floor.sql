-- run-as: migrator
-- A screen needs at least ONE HOUR between the end of one screening and the
-- start of the next, for cleaning. Chains may choose longer, never shorter.

ALTER TABLE tenant DROP CONSTRAINT tenant_turnaround_minutes_check;
UPDATE tenant SET turnaround_minutes = 60 WHERE turnaround_minutes < 60;
ALTER TABLE tenant ALTER COLUMN turnaround_minutes SET DEFAULT 60;
ALTER TABLE tenant ADD CONSTRAINT tenant_turnaround_minutes_check CHECK (turnaround_minutes BETWEEN 60 AND 240);

-- Every NEW screening carries at least 60 minutes. NOT VALID: screenings
-- already scheduled keep the turnaround they were created with — changing
-- them now could make existing, sold screenings overlap. Re-time them by hand
-- (or cancel and re-create) if the shorter gap matters.
ALTER TABLE screening DROP CONSTRAINT screening_turnaround_minutes_check;
ALTER TABLE screening ADD CONSTRAINT screening_turnaround_minutes_check
  CHECK (turnaround_minutes BETWEEN 60 AND 240) NOT VALID;
