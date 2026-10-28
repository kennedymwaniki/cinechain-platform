/**
 * PRD §13.1 — the five isolation assertions, against a real Postgres with the
 * full migration set applied, connected as the real application role.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TENANT_TABLES } from '../../src/db/tenant-tables';
import { seedTwoTenants, type TwoTenants } from './helpers/seed-two-tenants';

const urls = inject('db');
let app: Client;
let seed: TwoTenants;

async function scoped<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}
const countOf = async (table: string) =>
  (await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

beforeAll(async () => {
  seed = await seedTwoTenants(urls.adminUrl);
  app = new Client({ connectionString: urls.appUrl });
  await app.connect();
});
afterAll(() => app.end());

describe('row-level security', () => {
  it('1. per-tenant counts are exact under each scope', async () => {
    for (const side of ['A', 'B'] as const)
      for (const table of TENANT_TABLES)
        expect(await scoped(seed[side].id, () => countOf(table)), `${side}.${table}`).toBe(seed.expected[side][table]);
  });

  it('2. with NO tenant set, every tenant table returns 0 rows — not an error, not everything', async () => {
    for (const table of TENANT_TABLES) expect(await countOf(table), table).toBe(0);
  });

  it("3. WITH CHECK rejects inserting a row stamped with another tenant's id (42501)", async () => {
    await expect(
      scoped(seed.A.id, () =>
        app.query('INSERT INTO tenant_customer (tenant_id, email) VALUES ($1, $2)', [seed.B.id, 'planted@example.test']),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // ...and an UPDATE cannot move a row across the boundary either.
    await expect(
      scoped(seed.A.id, () => app.query('UPDATE staff_user SET tenant_id = $1', [seed.B.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  // 4 is the assertion that makes 1–3 meaningful. A BYPASSRLS (or owner)
  // connection passes all three by seeing everything — and then nothing here
  // would have tested a policy at all.
  it('4. the application role cannot bypass RLS and owns nothing', async () => {
    const { rows } = await app.query<{ rolbypassrls: boolean; rolsuper: boolean; owned: number }>(`
      SELECT r.rolbypassrls, r.rolsuper,
             (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
        FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false, owned: 0 });
    expect((await app.query('SELECT current_user AS u')).rows[0].u).toBe('cinechain_app');
  });

  it('5. platform.consumer is unreachable from the application role', async () => {
    await expect(app.query('SELECT * FROM platform.consumer')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the registry is not tenant data', () => {
  it('the app may read tenant but not write it; only the control plane writes', async () => {
    expect(await countOf('tenant')).toBeGreaterThanOrEqual(2);
    await expect(app.query(`INSERT INTO tenant (slug, name) VALUES ('nope', 'nope')`)).rejects.toMatchObject({
      code: '42501',
    });
    const control = new Client({ connectionString: urls.controlUrl });
    await control.connect();
    try {
      const { rows } = await control.query<{ id: string }>(
        `INSERT INTO tenant (slug, name) VALUES ('ctl-probe', 'probe') RETURNING id`,
      );
      await control.query('DELETE FROM tenant WHERE id = $1', [rows[0]!.id]);
    } finally {
      await control.end();
    }
  });
});
