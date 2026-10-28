-- The RLS generator. Applied on every `db:migrate`, after the migrations.
-- It is data-driven: the list of tables lives in ONE place,
-- src/db/tenant-tables.ts, and the runner calls this function once per entry.
-- Adding a tenant-scoped table is a one-line change there, never a
-- hand-written policy.
CREATE OR REPLACE FUNCTION public.apply_tenant_rls(t text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', t);

  EXECUTE format('DROP POLICY IF EXISTS p_tenant_isolation ON public.%I', t);
  EXECUTE format($f$
    CREATE POLICY p_tenant_isolation ON public.%I
      AS PERMISSIVE FOR ALL TO cinechain_app, cinechain_identity, cinechain_control
      USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  $f$, t);

  -- cinechain_control is listed so onboarding can write the few tables it is
  -- GRANTed (staff_user, staff_activation). A policy grants nothing by itself:
  -- without a table GRANT the role still gets permission denied.

  -- RESTRICTIVE twin: ANDed with every present AND FUTURE permissive policy,
  -- so one careless `USING (true)` added later cannot OR the isolation away.
  EXECUTE format('DROP POLICY IF EXISTS r_tenant_isolation ON public.%I', t);
  EXECUTE format($f$
    CREATE POLICY r_tenant_isolation ON public.%I
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  $f$, t);

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO cinechain_app', t);
END $fn$;
REVOKE ALL ON FUNCTION public.apply_tenant_rls(text) FROM PUBLIC;
