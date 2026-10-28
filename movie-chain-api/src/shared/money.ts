/**
 * Money is an INTEGER count of minor units with an explicit currency.
 * No floats, ever: 0.1 + 0.2 !== 0.3, and a ticketing system adds prices all
 * day. Field naming convention: `<name>_minor` / `<name>Minor`, always next to
 * a currency. A lint rule rejects `number` fields named like amounts.
 */
export const CURRENCIES = { KES: 2, UGX: 0, TZS: 2, RWF: 0, USD: 2 } as const;
export type Currency = keyof typeof CURRENCIES;

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export class MoneyError extends Error {}

function assertMinor(n: number): void {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`amount must be a safe integer of minor units, got ${n}`);
}

export function money(amountMinor: number, currency: Currency): Money {
  assertMinor(amountMinor);
  if (!(currency in CURRENCIES)) throw new MoneyError(`unsupported currency ${currency}`);
  return Object.freeze({ amountMinor, currency });
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

export const add = (a: Money, b: Money): Money => (same(a, b), money(a.amountMinor + b.amountMinor, a.currency));
export const subtract = (a: Money, b: Money): Money => (same(a, b), money(a.amountMinor - b.amountMinor, a.currency));

/** Multiplies by an integer quantity only — never by a fraction. */
export function times(m: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) throw new MoneyError('quantity must be an integer');
  return money(m.amountMinor * quantity, m.currency);
}

export function sum(items: Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

/**
 * Splits an amount by integer weights with no cent lost or invented (largest
 * remainder). allocate(KES 100.00, [1,1,1]) → 33.34, 33.33, 33.33.
 */
export function allocate(m: Money, weights: number[]): Money[] {
  if (!weights.length || weights.some((w) => !Number.isSafeInteger(w) || w < 0))
    throw new MoneyError('weights must be non-negative integers');
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) throw new MoneyError('weights must not all be zero');
  const shares = weights.map((w) => Math.floor((m.amountMinor * w) / total));
  let remainder = m.amountMinor - shares.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, frac: ((m.amountMinor * w) % total) / total }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) shares[order[k]!.i]! += 1;
  return shares.map((s) => money(s, m.currency));
}

export const isZero = (m: Money) => m.amountMinor === 0;
export const compare = (a: Money, b: Money) => (same(a, b), Math.sign(a.amountMinor - b.amountMinor));

/** The wire shape: `{ amount_minor, currency }`. */
export const toWire = (m: Money) => ({ amount_minor: m.amountMinor, currency: m.currency });
