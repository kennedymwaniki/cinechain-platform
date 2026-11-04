import { describe, expect, it } from 'vitest';
import type { Plan } from '../../db/schema/billing';
import { allocateCost } from './cost-model';
import { billableUnits, draftLines, totalOf } from './invoice.math';

const plan: Plan = {
  code: 'test',
  tier: 'basic',
  name: 'Test',
  currency: 'KES',
  basePriceMinor: 1_500_000,
  includedRequests: 1_000_000,
  includedBookings: 2_000,
  includedTickets: 5_000,
  includedHoldSeconds: 2_000_000,
  includedStorageBytes: 5 * 1024 ** 3,
  overageRequestsUnit: 1_000,
  overageRequestsMinor: 50,
  overageBookingsUnit: 1,
  overageBookingsMinor: 2_000,
  overageTicketsUnit: 1,
  overageTicketsMinor: 1_000,
  overageHoldSecondsUnit: 3_600,
  overageHoldSecondsMinor: 200,
  overageStorageBytesUnit: 1024 ** 3,
  overageStorageBytesMinor: 5_000,
  active: true,
};

describe('invoice arithmetic (integer minor units)', () => {
  it('units round UP, and nothing below the allowance is billed', () => {
    expect(billableUnits(1_000_000, 1_000_000, 1_000)).toBe(0);
    expect(billableUnits(1_000_001, 1_000_000, 1_000)).toBe(1); // one request over: one unit of 1 000
    expect(billableUnits(1_002_000, 1_000_000, 1_000)).toBe(2);
    expect(billableUnits(5, 10, 1)).toBe(0);
  });

  it('a month with overages: every amount is units × price, and the total is the sum of the lines', () => {
    const lines = draftLines(
      plan,
      { requests: 1_250_500, bookings: 2_010, tickets: 4_000, hold_seconds: 2_007_200, storage_bytes: 6 * 1024 ** 3 + 1 },
      { trialCoversPeriod: false },
    );
    const byKind = Object.fromEntries(lines.map((l) => [l.kind, l]));
    expect(byKind.requests).toMatchObject({ billableUnits: 251, amountMinor: 251 * 50 }); // 250 500 over → 251 units
    expect(byKind.bookings).toMatchObject({ billableUnits: 10, amountMinor: 20_000 });
    expect(byKind.tickets).toMatchObject({ billableUnits: 0, amountMinor: 0 });
    expect(byKind.hold_seconds).toMatchObject({ billableUnits: 2, amountMinor: 400 }); // 7 200 s over → 2 hours
    expect(byKind.storage_bytes).toMatchObject({ billableUnits: 2, amountMinor: 10_000 }); // 1 GiB + 1 byte over → 2 GiB
    expect(totalOf(lines)).toBe(1_500_000 + 12_550 + 20_000 + 400 + 10_000);
    for (const l of lines) {
      expect(Number.isSafeInteger(l.amountMinor)).toBe(true);
      expect(l.amountMinor).toBe(l.billableUnits * l.unitPriceMinor);
    }
  });

  it('a trial covering the period credits the base fee as its own line', () => {
    const lines = draftLines(plan, { requests: 0, bookings: 0, tickets: 0, hold_seconds: 0, storage_bytes: 0 }, { trialCoversPeriod: true });
    expect(lines.find((l) => l.kind === 'trial_credit')).toMatchObject({ amountMinor: -1_500_000 });
    expect(totalOf(lines)).toBe(0);
  });

  it('refuses a non-integer quantity rather than rounding it', () => {
    expect(() => draftLines(plan, { requests: 1.5, bookings: 0, tickets: 0, hold_seconds: 0, storage_bytes: 0 }, { trialCoversPeriod: false })).toThrow(/safe integer/);
  });
});

describe('cost model', () => {
  const u = (requests: number, hold_seconds: number, storage_bytes: number, tickets: number) => ({ requests, hold_seconds, storage_bytes, tickets });

  it('allocations sum to the bill EXACTLY, whatever the bill and the shares', () => {
    for (const total of [1, 7, 1_000_003, 987_654_321]) {
      const a = allocateCost(total, [
        { tenantId: 'a', usage: u(900_000, 50_000, 10 ** 9, 3_000) },
        { tenantId: 'b', usage: u(90_000, 5_000, 3 * 10 ** 8, 200) },
        { tenantId: 'c', usage: u(10_000, 0, 0, 7) },
      ]);
      expect(a.reduce((s, x) => s + x.allocatedMinor, 0)).toBe(total);
      expect(a.reduce((s, x) => s + x.sharePpm, 0)).toBe(1_000_000);
    }
  });

  it('follows consumption: the dominant tenant carries most of the bill', () => {
    const [a, b] = allocateCost(1_000_000, [
      { tenantId: 'a', usage: u(9_000, 9_000, 9_000, 9_000) },
      { tenantId: 'b', usage: u(1_000, 1_000, 1_000, 1_000) },
    ]);
    expect(a!.sharePpm).toBe(900_000);
    expect(b!.allocatedMinor).toBe(100_000);
  });

  it('a driver nobody used does not swallow its weight; no usage at all splits evenly enough to sum', () => {
    const [a] = allocateCost(100, [{ tenantId: 'a', usage: u(5, 0, 0, 0) }, { tenantId: 'b', usage: u(5, 0, 0, 0) }]);
    expect(a!.allocatedMinor).toBe(50);
    const idle = allocateCost(101, [{ tenantId: 'a', usage: u(0, 0, 0, 0) }, { tenantId: 'b', usage: u(0, 0, 0, 0) }]);
    expect(idle.reduce((s, x) => s + x.allocatedMinor, 0)).toBe(101);
  });
});
