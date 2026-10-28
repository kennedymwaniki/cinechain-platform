/**
 * "Operators cannot read booking data" is a GRANT, not a convention. This
 * pins the control role's privileges on tenant tables to an explicit list:
 * any new grant (and in particular one on booking/ticket/payment) fails here.
 */
import { describe, expect, inject, it } from 'vitest';
import { asAdmin } from '../support/seed';

const ALLOWED: Record<string, string[]> = {
  film: ['DELETE', 'INSERT', 'SELECT'],
  pricing_rule: ['DELETE', 'INSERT', 'SELECT'],
  screen: ['DELETE', 'INSERT', 'SELECT'],
  seat: ['DELETE', 'INSERT', 'SELECT'],
  staff_activation: ['DELETE', 'INSERT', 'SELECT'],
  staff_user: ['DELETE', 'INSERT', 'SELECT'],
  tenant: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  theatre: ['DELETE', 'INSERT', 'SELECT'],
};

describe('control-plane grants', () => {
  it('cinechain_control holds privileges on exactly the reviewed public tables', async () => {
    const { rows } = await asAdmin(inject('db').adminUrl, (c) =>
      c.query<{ table_name: string; privs: string[] }>(
        `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type) AS privs
           FROM information_schema.role_table_grants
          WHERE grantee = 'cinechain_control' AND table_schema = 'public'
          GROUP BY table_name ORDER BY table_name`,
      ),
    );
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.privs]))).toEqual(ALLOWED);
  });

  it('cinechain_control cannot read the consumer directory or tenant customers', async () => {
    const { rows } = await asAdmin(inject('db').adminUrl, (c) =>
      c.query(`SELECT has_table_privilege('cinechain_control', 'platform.consumer', 'SELECT') AS consumer,
                      has_table_privilege('cinechain_control', 'tenant_customer', 'SELECT') AS customers`),
    );
    expect(rows[0]).toEqual({ consumer: false, customers: false });
  });
});
