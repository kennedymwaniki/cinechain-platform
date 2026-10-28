/**
 * tenant_id must come from a source the caller cannot forge. This scans the
 * application source for every way a request could hand us one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });

const FORBIDDEN: [string, RegExp][] = [
  ['tenant from a route param', /@Param\(\s*['"`]tenant_?[Ii]d['"`]/],
  ['tenant from a query string', /@Query\(\s*['"`]tenant_?[Ii]d['"`]/],
  ['tenant from a header', /headers\s*(\[\s*['"`]x-tenant|\.\s*['"]?x-tenant|\.get\(\s*['"`]x-tenant)/i],
  ['tenant from a body', /(body|dto|input)\??\.\s*tenant_?[Ii]d\b/],
  ['tenant id in a URL template', /:tenant_?[Ii]d\b/],
];

describe('no caller-supplied tenant id', () => {
  it('no route reads tenant_id from a path, query, header or body', () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const [what, re] of FORBIDDEN) if (re.test(text)) hits.push(`${relative(SRC, f)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
