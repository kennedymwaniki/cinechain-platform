/**
 * platform.consumer sits OUTSIDE the tenant boundary, so it must be reachable
 * through exactly one service — and the application role must still get
 * permission denied.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Client } from 'pg';
import { describe, expect, inject, it } from 'vitest';

const SRC = join(__dirname, '../../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });

describe('identity boundary', () => {
  it('only src/identity/consumer.service.ts uses the platform consumer tables', () => {
    // Any import of these three tables from the platform schema module.
    const importsConsumerTables =
      /import\s*{[^}]*\b(consumer|consumerIdentity|emailVerification)\b[^}]*}\s*from\s*['"][./]*db\/schema\/platform['"]/;
    const users = files(SRC)
      .filter((f) => !f.includes('/db/schema/'))
      .filter((f) => importsConsumerTables.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(users).toEqual(['identity/consumer.service.ts']);
  });

  it('the application role cannot read platform.consumer', async () => {
    const c = new Client({ connectionString: inject('db').appUrl });
    await c.connect();
    try {
      await expect(c.query('SELECT 1 FROM platform.consumer')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });
});
