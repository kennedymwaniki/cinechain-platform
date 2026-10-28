/**
 * The test that protects you from your future self. It fails the build when
 * any table, policy or cross-tenant function drifts from the reviewed lists in
 * src/db/tenant-tables.ts — so a new table without a policy fails here
 * automatically, with no one having to remember to write a test for it.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RLS_EXEMPT_TABLES, SANCTIONED_DOORS, TENANT_TABLES } from '../../src/db/tenant-tables';

const urls = inject('db');
let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: urls.adminUrl });
  await admin.connect();
});
afterAll(() => admin.end());

describe('schema guard', () => {
  it('every non-exempt table in public has tenant_id NOT NULL, RLS enabled AND forced, and a policy', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND c.relname <> ALL ($1::text[])                       -- the reviewed allowlist
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR NOT EXISTS (SELECT 1 FROM pg_policies p
                            WHERE p.schemaname = 'public' AND p.tablename = c.relname)
            OR NOT EXISTS (SELECT 1 FROM information_schema.columns col
                            WHERE col.table_schema = 'public' AND col.table_name = c.relname
                              AND col.column_name = 'tenant_id' AND col.is_nullable = 'NO'))
        ORDER BY 1`,
      [RLS_EXEMPT_TABLES],
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('TENANT_TABLES is exactly the set of non-exempt tables in public', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> ALL ($1::text[])
        ORDER BY 1`,
      [RLS_EXEMPT_TABLES],
    );
    expect(rows.map((r) => r.relname)).toEqual([...TENANT_TABLES].sort());
  });

  it('every tenant table carries BOTH the permissive and the restrictive policy, each with USING and WITH CHECK', async () => {
    const { rows } = await admin.query<{ tablename: string; policyname: string; permissive: string; ok: boolean }>(
      `SELECT tablename, policyname, permissive,
              (qual IS NOT NULL AND with_check IS NOT NULL
               AND qual LIKE '%app.tenant_id%' AND with_check LIKE '%app.tenant_id%') AS ok
         FROM pg_policies WHERE schemaname = 'public'`,
    );
    for (const t of TENANT_TABLES) {
      const mine = rows.filter((r) => r.tablename === t);
      expect(mine.find((r) => r.permissive === 'PERMISSIVE' && r.ok), `${t}: permissive`).toBeTruthy();
      expect(mine.find((r) => r.permissive === 'RESTRICTIVE' && r.ok), `${t}: restrictive`).toBeTruthy();
    }
  });

  // Convention 11. FK checks bypass RLS, so a single-column FK between tenant
  // tables would accept another chain's parent id. Every such FK must include tenant_id.
  it('every foreign key between tenant tables includes tenant_id', async () => {
    const { rows } = await admin.query<{ child: string; fk: string }>(
      `SELECT cl.relname AS child, con.conname AS fk
         FROM pg_constraint con
         JOIN pg_class cl  ON cl.oid  = con.conrelid
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'
          AND cl.relname = ANY ($1::text[]) AND ref.relname = ANY ($1::text[])
          AND NOT EXISTS (SELECT 1 FROM unnest(con.conkey) k
                            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
                           WHERE a.attname = 'tenant_id')
        ORDER BY 1, 2`,
      [TENANT_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it('no RLS exemption exists beyond the reviewed list', async () => {
    expect([...RLS_EXEMPT_TABLES].sort()).toEqual(['drizzle_migrations', 'tenant']);
  });

  it('the application role owns nothing and has no privileges on platform.*', async () => {
    const { rows } = await admin.query<{ owned: number; platform: boolean }>(`
      SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
               WHERE r.rolname = 'cinechain_app') AS owned,
             has_schema_privilege('cinechain_app', 'platform', 'USAGE') AS platform`);
    expect(rows[0]).toEqual({ owned: 0, platform: false });
  });

  it('SECURITY DEFINER functions are exactly the sanctioned doors, owned by cinechain_resolver, search_path pinned', async () => {
    const { rows } = await admin.query<{ name: string; owner: string; pinned: boolean }>(
      `SELECT p.proname AS name, r.rolname AS owner,
              coalesce(array_to_string(p.proconfig, ',') LIKE '%search_path=%', false) AS pinned
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([...SANCTIONED_DOORS].sort());
    for (const r of rows) expect(r, r.name).toMatchObject({ owner: 'cinechain_resolver', pinned: true });
  });
});
