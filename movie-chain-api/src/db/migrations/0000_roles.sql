-- run-as: admin
-- Cluster-level roles. Roles outlive a dropped database, so every statement
-- is idempotent. Passwords are NOT set here: db:migrate sets them from the
-- environment afterwards, so no secret is ever committed.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- role                 login   bypassrls
    ('cinechain_migrator',  false,  false),   -- owns every object; migrations only
    ('cinechain_app',       true,   false),   -- application plane: NOT owner, NOBYPASSRLS
    ('cinechain_identity',  true,   false),   -- the only role granted on platform.*
    ('cinechain_control',   true,   false),   -- control plane: no grants on booking/ticket/payment
    ('cinechain_sweeper',   true,   true),    -- BYPASSRLS, granted only on seat_lock (step 15)
    ('cinechain_resolver',  false,  true)     -- NOLOGIN, owns the sanctioned read doors (correction 5)
  ) AS t(name, login, bypass)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I NOINHERIT', r.name);
    END IF;
    EXECUTE format('ALTER ROLE %I %s %s NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE',
                   r.name,
                   CASE WHEN r.login  THEN 'LOGIN'     ELSE 'NOLOGIN'     END,
                   CASE WHEN r.bypass THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END);
  END LOOP;
END $$;

-- The migrator creates the platform schema and trusted extensions.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE, CONNECT ON DATABASE %I TO cinechain_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cinechain_app, cinechain_identity, cinechain_control, cinechain_sweeper',
                 current_database());
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO cinechain_migrator;

-- The sanctioned read doors are created by the migrator and then handed to
-- cinechain_resolver (correction 5). Changing a function's owner requires
-- being able to SET ROLE to the new owner, and the new owner needs CREATE on
-- the schema. cinechain_resolver stays NOLOGIN: only the migrator reaches it.
GRANT cinechain_resolver TO cinechain_migrator;
GRANT CREATE, USAGE ON SCHEMA public TO cinechain_resolver;
