import { describe, expect, it } from 'vitest';
import { add, allocate, money, MoneyError, sum, times } from './money';

describe('money', () => {
  it('refuses fractional minor units', () => {
    expect(() => money(10.5, 'KES')).toThrow(MoneyError);
    expect(() => money(0.1 + 0.2, 'KES')).toThrow(MoneyError);
  });
  it('refuses mixing currencies', () => {
    expect(() => add(money(100, 'KES'), money(100, 'USD'))).toThrow(/currency mismatch/);
  });
  it('multiplies by integer quantities only', () => {
    expect(times(money(65000, 'KES'), 3).amountMinor).toBe(195000);
    expect(() => times(money(100, 'KES'), 1.5)).toThrow(MoneyError);
  });
  it('allocates without losing or inventing a cent', () => {
    const parts = allocate(money(10000, 'KES'), [1, 1, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([3334, 3333, 3333]);
    expect(sum(parts, 'KES').amountMinor).toBe(10000);
    for (let total = 1; total < 500; total += 37) {
      const p = allocate(money(total, 'KES'), [3, 5, 7, 11]);
      expect(sum(p, 'KES').amountMinor).toBe(total);
    }
  });
});
