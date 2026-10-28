import type { ScreenFormat, SeatClass } from '../db/schema/venue';
import { type Currency, type Money, money } from '../shared/money';

export interface RuleLike {
  seatClass: SeatClass;
  format: ScreenFormat | null; // null = every format
  priceMinor: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null; // null = open-ended
}

const covers = (r: RuleLike, at: Date) =>
  r.effectiveFrom.getTime() <= at.getTime() && (r.effectiveTo === null || at.getTime() < r.effectiveTo.getTime());

/**
 * PURE: (rules, seat class, format, instant) → price. No clock, no database.
 * A rule for the exact format beats a format-agnostic one. A rule only
 * applies within [effective_from, effective_to), so a rule created today can
 * never change the price of an instant in the past.
 */
export function resolvePrice(rules: readonly RuleLike[], seatClass: SeatClass, format: ScreenFormat, at: Date): Money | null {
  const live = rules.filter((r) => r.seatClass === seatClass && covers(r, at));
  const rule = live.find((r) => r.format === format) ?? live.find((r) => r.format === null);
  return rule ? money(rule.priceMinor, rule.currency as Currency) : null;
}
