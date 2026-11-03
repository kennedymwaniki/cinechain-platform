import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runWithTenant } from '../tenancy/tenant-context';
import { PinoLogger, scrub } from './logger';
import { requestAls } from './request-context';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { logger: new PinoLogger({ level: 'debug', destination }), lines };
}
const flush = () => new Promise((r) => setImmediate(r));
const T = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('tenant-attributed logs (PRD §14.1)', () => {
  it('tenant_id and request_id land on every line inside a scope, with no call-site effort', async () => {
    const { logger, lines } = capture();
    await requestAls.run({ requestId: 'req-12345678', tenantId: null }, () =>
      runWithTenant({ tenantId: T, actor: { kind: 'guest' } }, async () => logger.log('hold placed', 'HoldService')),
    );
    logger.warn('outside any scope');
    await flush();
    expect(lines[0]).toMatchObject({ msg: 'hold placed', tenant_id: T, request_id: 'req-12345678', context: 'HoldService', level: 'info' });
    expect(lines[1]).not.toHaveProperty('tenant_id');
  });

  it('no e-mail, phone number, card token or bearer token survives, in a message or a field', async () => {
    const { logger, lines } = capture();
    logger.error('payment for grace.w@example.test on +254712345678 with tok_abc123_4242 failed; Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln');
    logger.log({ msg: 'booking', contact: { name: 'Grace Wanjiru', email: 'grace.w@example.test' }, guest_name: 'Grace Wanjiru', card_token: 'tok_x_1111' });
    await flush();
    const text = JSON.stringify(lines);
    for (const secret of ['grace.w@example.test', '+254712345678', 'tok_abc123_4242', 'tok_x_1111', 'Grace Wanjiru', 'eyJhbGciOiJFZERTQSJ9'])
      expect(text, secret).not.toContain(secret);
    expect(lines[0]!.msg).toBe('payment for [email] on [phone] with [card_token] failed; Bearer [token]');
  });

  it('scrub leaves ordinary operational text alone', () => {
    expect(scrub('refunded 2 orphaned capture(s) for booking NYA-7KQ3XP in 120 ms')).toBe('refunded 2 orphaned capture(s) for booking NYA-7KQ3XP in 120 ms');
  });

  it('no log call in src/ names a tenant itself — the logger adds it', () => {
    const SRC = join(__dirname, '..');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const offenders = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.includes('/observability/'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f, i: i + 1, line }))
          // Only the logger call's own arguments: `this.log.warn(...)`, to the end of the line.
          .filter(({ line }) => /tenant/i.test(line.match(/this\.log\.(?:log|warn|error|debug|verbose|fatal)\((.*)$/)?.[1] ?? '')),
      )
      .map(({ f, i, line }) => `${f.slice(SRC.length)}:${i}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
