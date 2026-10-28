-- run-as: migrator
-- Step 15. cinechain_sweeper is BYPASSRLS (it reconciles every tenant's
-- expired holds in one pass), so its reach is limited by GRANT instead:
-- exactly seat_lock, exactly the columns and verbs the sweep needs.
GRANT SELECT (screening_id, seat_id, tenant_id, status, expires_at), DELETE ON seat_lock TO cinechain_sweeper;
