import { describe, expect, it } from 'vitest';
import { clampLimit, decodeCursor, encodeCursor, toPage } from './pagination';

describe('cursor pagination', () => {
  it('round-trips a keyset cursor', () => {
    expect(decodeCursor(encodeCursor(['2026-10-28T10:00:00Z', 'abc']), 2)).toEqual(['2026-10-28T10:00:00Z', 'abc']);
  });
  it('rejects tampered or malformed cursors with a 400-class error', () => {
    expect(() => decodeCursor('not-a-cursor', 2)).toThrow(/cursor/);
    expect(() => decodeCursor(encodeCursor(['only-one']), 2)).toThrow(/cursor/);
  });
  it('trims the extra row and emits the next cursor', () => {
    const page = toPage([1, 2, 3, 4], 3, (n) => [n]);
    expect(page.items).toEqual([1, 2, 3]);
    expect(decodeCursor(page.next_cursor!, 1)).toEqual([3]);
    expect(toPage([1, 2], 3, (n) => [n]).next_cursor).toBeNull();
  });
  it('clamps limits', () => {
    expect([clampLimit(undefined), clampLimit('500'), clampLimit('-3'), clampLimit('10')]).toEqual([25, 100, 25, 10]);
  });
});
