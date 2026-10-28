import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

export interface SeededTenant {
  id: string;
  slug: string;
}

/** Runs as the bootstrap superuser, which bypasses RLS — for seeding only. */
export async function asAdmin<T>(adminUrl: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createTenant(c: Client, slug = `t-${randomUUID().slice(0, 8)}`): Promise<SeededTenant> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO tenant (slug, name, status) VALUES ($1, $1, 'active') RETURNING id`,
    [slug],
  );
  return { id: rows[0]!.id, slug };
}

export async function addCustomers(c: Client, tenantId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++)
    await c.query('INSERT INTO tenant_customer (tenant_id, email) VALUES ($1, $2)', [
      tenantId,
      `c${i}-${randomUUID().slice(0, 6)}@example.test`,
    ]);
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';
let cachedHash: string | undefined;

/** Adds an active staff user with TEST_PASSWORD. Returns its id. */
export async function addStaff(
  c: Client,
  tenantId: string,
  email: string,
  role: 'box_office' | 'theatre_manager' | 'chain_admin' = 'chain_admin',
): Promise<string> {
  const argon2 = (await import('argon2')).default;
  cachedHash ??= await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO staff_user (tenant_id, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, email, role, cachedHash],
  );
  return rows[0]!.id;
}

/** An active platform operator with TEST_PASSWORD. */
export async function addOperator(c: Client, email: string): Promise<void> {
  const argon2 = (await import('argon2')).default;
  cachedHash ??= await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await c.query(`INSERT INTO platform.operator (email, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [email, cachedHash]);
}
