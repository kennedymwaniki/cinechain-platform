/**
 * Cost per tenant (step 26). Everything is POOLED, so there is no per-tenant
 * resource to read a bill from: the period's infrastructure bill is
 * apportioned by each tenant's share of what drives it. An estimate accurate
 * to ~20 % transforms pricing conversations; the perfect model that is never
 * built helps nobody.
 *
 * The model, stated so it can be argued with:
 *   - compute (API instances, Postgres CPU) follows REQUESTS        weight 50
 *   - Redis memory and lock traffic follow HOLD-SECONDS             weight 20
 *   - object storage follows STORAGE BYTES                          weight 20
 *   - write volume (bookings, tickets, payments) follows TICKETS    weight 10
 * A tenant's share = Σ weight × (its share of that driver) / Σ weight.
 *
 * PURE and integer-only: shares are parts-per-million computed with BigInt,
 * and the bill is split by largest remainder, so the allocations sum to the
 * bill EXACTLY (tolerance: 0 minor units).
 */
export const DRIVERS = { requests: 50, hold_seconds: 20, storage_bytes: 20, tickets: 10 } as const;
export type Driver = keyof typeof DRIVERS;

export interface TenantUsage {
  tenantId: string;
  usage: Record<Driver, number>;
}

export interface Allocation {
  tenantId: string;
  sharePpm: number;
  allocatedMinor: number;
}

const PPM = 1_000_000n;

export function allocateCost(totalMinor: number, tenants: readonly TenantUsage[]): Allocation[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error('total must be a non-negative integer of minor units');
  if (!tenants.length) return [];
  const drivers = Object.entries(DRIVERS) as [Driver, number][];
  const totals = Object.fromEntries(drivers.map(([d]) => [d, tenants.reduce((a, t) => a + BigInt(t.usage[d]), 0n)])) as Record<Driver, bigint>;
  // Only drivers somebody actually used carry weight (an empty driver must not swallow its weight).
  const live = drivers.filter(([d]) => totals[d] > 0n);
  const weightSum = BigInt(live.reduce((a, [, w]) => a + w, 0));

  // Weighted share in a common denominator: Σ_d w_d · u_t,d · Π(other totals) / (Σw · Π totals) — kept exact with BigInt.
  const raw = tenants.map((t) => {
    if (weightSum === 0n) return 1n; // nobody used anything: split evenly
    let num = 0n;
    for (const [d, w] of live) {
      let term = BigInt(w) * BigInt(t.usage[d]);
      for (const [o] of live) if (o !== d) term *= totals[o];
      num += term;
    }
    return num;
  });
  const sharesPpm = largestRemainder(PPM, raw).map(Number);
  const allocated = largestRemainder(BigInt(totalMinor), sharesPpm.map(BigInt)).map(Number);
  return tenants.map((t, i) => ({ tenantId: t.tenantId, sharePpm: sharesPpm[i]!, allocatedMinor: allocated[i]! }));
}

/** Split `total` in proportion to `weights` with nothing lost or invented (largest remainder, ties by position). */
function largestRemainder(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0n));
  const base = weights.map((w) => (total * w) / sum);
  let left = total - base.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (let k = 0; left > 0n; k = (k + 1) % order.length, left--) base[order[k]!.i]! += 1n;
  return base;
}
