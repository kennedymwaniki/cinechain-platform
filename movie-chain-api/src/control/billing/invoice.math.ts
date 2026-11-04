import type { LineKind, Plan } from '../../db/schema/billing';

/**
 * PURE: plan + usage → invoice lines. Integer minor units only; every amount
 * is units × an integer price, and units are a ceiling of an integer division.
 * The database re-checks the same arithmetic (CHECK constraints in 0023).
 */
export interface Usage {
  requests: number;
  bookings: number;
  tickets: number;
  hold_seconds: number;
  storage_bytes: number;
}

export interface LineDraft {
  kind: LineKind;
  description: string;
  meteredQuantity: number;
  includedQuantity: number;
  unitSize: number;
  billableUnits: number;
  unitPriceMinor: number;
  amountMinor: number;
}

export const METERS = ['requests', 'bookings', 'tickets', 'hold_seconds', 'storage_bytes'] as const satisfies readonly (keyof Usage)[];

function int(n: number, what: string): number {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer, got ${n}`);
  return n;
}

/** ceil(max(metered − included, 0) / unit), in integers. */
export function billableUnits(metered: number, included: number, unit: number): number {
  const over = Math.max(int(metered, 'metered') - int(included, 'included'), 0);
  return Math.floor((over + int(unit, 'unit') - 1) / unit);
}

const LABEL: Record<(typeof METERS)[number], string> = {
  requests: 'API requests',
  bookings: 'Bookings',
  tickets: 'Tickets issued',
  hold_seconds: 'Seat-hold seconds',
  storage_bytes: 'Object storage (bytes)',
};

function terms(p: Plan, meter: (typeof METERS)[number]): { included: number; unit: number; priceMinor: number } {
  switch (meter) {
    case 'requests':
      return { included: p.includedRequests, unit: p.overageRequestsUnit, priceMinor: p.overageRequestsMinor };
    case 'bookings':
      return { included: p.includedBookings, unit: p.overageBookingsUnit, priceMinor: p.overageBookingsMinor };
    case 'tickets':
      return { included: p.includedTickets, unit: p.overageTicketsUnit, priceMinor: p.overageTicketsMinor };
    case 'hold_seconds':
      return { included: p.includedHoldSeconds, unit: p.overageHoldSecondsUnit, priceMinor: p.overageHoldSecondsMinor };
    case 'storage_bytes':
      return { included: p.includedStorageBytes, unit: p.overageStorageBytesUnit, priceMinor: p.overageStorageBytesMinor };
  }
}

/**
 * The lines for one period. A trial covering the whole period credits the
 * base fee back as its own line (so the invoice still shows what the plan costs).
 */
export function draftLines(p: Plan, usage: Usage, opts: { trialCoversPeriod: boolean }): LineDraft[] {
  const lines: LineDraft[] = [
    {
      kind: 'base',
      description: `${p.name} plan`,
      meteredQuantity: 0,
      includedQuantity: 0,
      unitSize: 1,
      billableUnits: 1,
      unitPriceMinor: p.basePriceMinor,
      amountMinor: p.basePriceMinor,
    },
  ];
  if (opts.trialCoversPeriod)
    lines.push({
      kind: 'trial_credit',
      description: 'Trial: base fee waived',
      meteredQuantity: 0,
      includedQuantity: 0,
      unitSize: 1,
      billableUnits: 1,
      unitPriceMinor: -p.basePriceMinor,
      amountMinor: -p.basePriceMinor,
    });
  for (const m of METERS) {
    const t = terms(p, m);
    const units = billableUnits(usage[m], t.included, t.unit);
    lines.push({
      kind: m,
      description: `${LABEL[m]}: ${usage[m]} used, ${t.included} included`,
      meteredQuantity: int(usage[m], m),
      includedQuantity: t.included,
      unitSize: t.unit,
      billableUnits: units,
      unitPriceMinor: t.priceMinor,
      amountMinor: int(units * t.priceMinor, `${m} amount`),
    });
  }
  return lines;
}

export const totalOf = (lines: readonly { amountMinor: number }[]) => lines.reduce((a, l) => a + l.amountMinor, 0);
