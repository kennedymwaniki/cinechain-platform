import { describe, expect, it } from 'vitest';
import { resolvePrice, type RuleLike } from './price-resolver';

const d = (iso: string) => new Date(iso);
const rule = (p: Partial<RuleLike>): RuleLike => ({
  seatClass: 'standard',
  format: null,
  priceMinor: 65000,
  currency: 'KES',
  effectiveFrom: d('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  ...p,
});

describe('resolvePrice — a pure function of (rules, seat class, format, instant)', () => {
  it('a rule created today with effective_from = today does NOT change the price of a past instant', () => {
    const old = rule({ effectiveTo: d('2026-10-29T00:00:00Z') });
    const today = rule({ priceMinor: 80000, effectiveFrom: d('2026-10-29T00:00:00Z') });
    const rules = [old, today];
    expect(resolvePrice(rules, 'standard', 'standard', d('2026-10-28T20:30:00Z'))?.amountMinor).toBe(65000);
    expect(resolvePrice(rules, 'standard', 'standard', d('2026-10-29T20:30:00Z'))?.amountMinor).toBe(80000);
  });

  it('effective_to is exclusive, effective_from inclusive', () => {
    const rules = [rule({ effectiveTo: d('2026-06-01T00:00:00Z') }), rule({ priceMinor: 70000, effectiveFrom: d('2026-06-01T00:00:00Z') })];
    expect(resolvePrice(rules, 'standard', 'standard', d('2026-05-31T23:59:59.999Z'))?.amountMinor).toBe(65000);
    expect(resolvePrice(rules, 'standard', 'standard', d('2026-06-01T00:00:00Z'))?.amountMinor).toBe(70000);
  });

  it('a format-specific rule beats the format-agnostic one', () => {
    const rules = [rule({}), rule({ format: 'imax', priceMinor: 150000 })];
    expect(resolvePrice(rules, 'standard', 'imax', d('2026-07-01T00:00:00Z'))?.amountMinor).toBe(150000);
    expect(resolvePrice(rules, 'standard', '3d', d('2026-07-01T00:00:00Z'))?.amountMinor).toBe(65000);
  });

  it('prices are per seat class, integer minor units with a currency', () => {
    const rules = [rule({}), rule({ seatClass: 'vip', priceMinor: 120000 })];
    expect(resolvePrice(rules, 'vip', 'standard', d('2026-07-01T00:00:00Z'))).toEqual({ amountMinor: 120000, currency: 'KES' });
  });

  it('no covering rule → null (the caller decides; never a silent zero)', () => {
    expect(resolvePrice([rule({})], 'companion', 'standard', d('2026-07-01T00:00:00Z'))).toBeNull();
    expect(resolvePrice([rule({})], 'standard', 'standard', d('2025-12-31T23:59:59Z'))).toBeNull();
  });
});
