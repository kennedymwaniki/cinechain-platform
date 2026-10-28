import { describe, expect, it } from 'vitest';
import { internalState, toExternal } from './seat-state.mapper';

const now = Date.parse('2026-10-29T12:00:00Z');
const future = '2026-10-29T12:05:00Z';
const past = '2026-10-29T11:55:00Z';

describe('seat state mask', () => {
  it('maps every internal state to exactly free | taken | yours', () => {
    expect(toExternal('AVAILABLE')).toBe('free');
    expect(toExternal('HELD_BY_ME')).toBe('yours');
    expect(['HELD_BY_OTHER', 'SOLD', 'REDEEMED'].map((s) => toExternal(s as never))).toEqual(['taken', 'taken', 'taken']);
  });

  it('held by someone else and sold look identical from outside', () => {
    const held = toExternal(internalState({ status: 'held', holdId: 'h1', expiresAt: future }, 'other', now));
    const sold = toExternal(internalState({ status: 'sold', holdId: null, expiresAt: null }, 'other', now));
    expect(held).toBe(sold);
  });

  it("the viewer's own hold is 'yours'; an expired hold is free again", () => {
    expect(internalState({ status: 'held', holdId: 'h1', expiresAt: future }, 'h1', now)).toBe('HELD_BY_ME');
    expect(internalState({ status: 'held', holdId: 'h1', expiresAt: past }, null, now)).toBe('AVAILABLE');
    expect(internalState(undefined, 'h1', now)).toBe('AVAILABLE');
  });

  it('a sold seat never becomes free by the clock', () => {
    expect(internalState({ status: 'sold', holdId: null, expiresAt: null }, null, now + 1e9)).toBe('SOLD');
  });
});
