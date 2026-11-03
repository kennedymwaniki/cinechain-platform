# A tenant reports seeing another tenant's data

**A security incident from the first minute.** Alert (related): `CrossTenantProbing`.

1. Capture the request identifier, the exact request and the exact response. Preserve logs.
2. Verify the database guarantees still hold — a migration run as the owner can silently change them:
   ```sql
   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'cinechain_app';   -- f, f
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname = '<table>';                                                              -- t, t
   ```
   Then run the suite that asserts all of it: `pnpm test:isolation`.
3. Check the sanctioned doors (`SANCTIONED_DOORS` in `src/db/tenant-tables.ts`): any new
   `SECURITY DEFINER` function is a cross-tenant read path.
4. **Do not deploy a fix before establishing the blast radius**: which tenants, which rows, over
   what period. `platform.security_event` records `tenant_mismatch` and `wrong_token_type` events.
