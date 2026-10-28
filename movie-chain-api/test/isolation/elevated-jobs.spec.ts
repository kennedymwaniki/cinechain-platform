/**
 * Convention 10: exactly two jobs run without a tenant scope, both marked
 * @CrossTenantJob and both listed in ELEVATED_JOBS.md. Until step 24 adds the
 * metering roll-up there is exactly ONE. Adding another fails here — that is
 * the review.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SweeperDb } from '../../src/tenancy/sweeper-db.provider';

const SRC = join(__dirname, '../../src');
const EXPECTED = ['SweeperProcessor']; // step 24 adds the metering roll-up

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

const urls = inject('db');
let sweeper: Client;

beforeAll(async () => {
  sweeper = new Client({ connectionString: urls.sweeperUrl });
  await sweeper.connect();
});
afterAll(() => sweeper.end());

describe('elevated (cross-tenant) jobs', () => {
  it('exactly the expected classes are marked @CrossTenantJob', () => {
    const marked = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/@CrossTenantJob\([\s\S]*?\)\s*(?:@\w+\([^)]*\)\s*)*export class (\w+)/g)].map((m) => m[1]!));
    expect(marked.sort()).toEqual(EXPECTED);
  });

  it('ELEVATED_JOBS.md lists exactly the marked jobs', () => {
    const doc = readFileSync(join(SRC, 'common/elevated/ELEVATED_JOBS.md'), 'utf8');
    const listed = [...doc.matchAll(/^\| `(\w+)` \(/gm)].map((m) => m[1]!);
    expect(listed.sort()).toEqual(EXPECTED);
  });

  it('cinechain_sweeper bypasses RLS but can reach seat_lock only, and only the columns the sweep needs', async () => {
    const role = (await sweeper.query('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0];
    expect(role).toEqual({ rolbypassrls: true, rolsuper: false });
    await expect(sweeper.query('SELECT * FROM seat_lock LIMIT 1')).rejects.toMatchObject({ code: '42501' }); // hold_id, booking_id: not granted
    await expect(sweeper.query('SELECT screening_id, seat_id, tenant_id, status, expires_at FROM seat_lock LIMIT 1')).resolves.toBeTruthy();
    await expect(sweeper.query(`UPDATE seat_lock SET status = 'sold'`)).rejects.toMatchObject({ code: '42501' });
    for (const t of ['tenant', 'screening', 'staff_user', 'tenant_customer', 'audit_event', 'platform.consumer'])
      await expect(sweeper.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toMatchObject({ code: '42501' });
  });

  it("the sweeper's own boot check passes now, and would refuse a widened grant", async () => {
    const db = new SweeperDb(urls.sweeperUrl);
    try {
      await expect(db.assertNarrowRole()).resolves.toBeUndefined();
      const admin = new Client({ connectionString: urls.adminUrl });
      await admin.connect();
      try {
        await admin.query('GRANT SELECT ON screening TO cinechain_sweeper');
        await expect(db.assertNarrowRole()).rejects.toThrow(/can read screening/);
      } finally {
        await admin.query('REVOKE SELECT ON screening FROM cinechain_sweeper');
        await admin.end();
      }
    } finally {
      await db.onApplicationShutdown();
    }
  });
});
