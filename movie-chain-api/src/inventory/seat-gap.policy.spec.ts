import { describe, expect, it } from 'vitest';
import { checkSeatGap, type GapConfig, type GapSeat } from './seat-gap.policy';

/** One row of 10 seats, A1..A10 at cols 0..9, plus row B (10 seats) so occupancy has room. */
function room(opts: { aisleAfter?: number; inactive?: number[]; rows?: number } = {}): GapSeat[] {
  const seats: GapSeat[] = [];
  for (let r = 0; r < (opts.rows ?? 1); r++)
    for (let n = 1; n <= 10; n++) {
      if (r === 0 && opts.inactive?.includes(n)) continue;
      const col = n - 1 + (opts.aisleAfter !== undefined && n > opts.aisleAfter ? 1 : 0);
      seats.push({ id: `${'AB'[r]}${n}`, row: r, col, seatClass: 'standard' });
    }
  return seats;
}

const demand: GapConfig = { policy: 'demand', occupancyThreshold: 60, liftMinutes: 30 };
const FAR = 24 * 60;
const takenSet = (...ids: string[]) => new Set(ids);

/** Taken: A1,A2 and A5..A10 minus what's needed; choose A4 → strands A3. */
const busyRow = takenSet('A1', 'A2', 'A6', 'A7', 'A8', 'A9', 'A10');

describe('seat-gap policy (FR-47, demand-driven)', () => {
  it('a selection that strands one seat is rejected at 80 % occupancy, with a gap-free suggestion', () => {
    // 1 row of 10: 7 taken + 1 selected = 80 %. A3..A5 free; A4 strands A3 AND A5; A3 alone strands nothing.
    const v = checkSeatGap(room(), busyRow, ['A4'], FAR, demand);
    expect(v).toEqual({ ok: false, gapSeatIds: ['A3', 'A5'], suggestion: ['A3'] });
  });

  it('the same gap-creating selection is accepted at 25 % occupancy', () => {
    // 2 rows (20 seats): A1, A2, A6 + A4 selected = 4 / 20 = 20 % … add A7 → 25 %.
    const v = checkSeatGap(room({ rows: 2 }), takenSet('A2', 'A6', 'A7', 'A8'), ['A4'], FAR, demand);
    expect(v).toEqual({ ok: true, reason: 'below_threshold' });
  });

  it('is accepted within 30 minutes of the start: late buyers take what is left', () => {
    expect(checkSeatGap(room(), busyRow, ['A4'], 25, demand)).toEqual({ ok: true, reason: 'starting_soon' });
  });

  it('is accepted when no gap-free block of the same size and class exists', () => {
    // Only A3 and A4 are free; choosing A4 strands A3, but there is no other single seat that strands nothing.
    const seats = room().map((s) => (s.id === 'A3' ? { ...s, seatClass: 'vip' } : s));
    expect(checkSeatGap(seats, takenSet('A1', 'A2', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'), ['A4'], FAR, demand)).toEqual({
      ok: true,
      reason: 'no_alternative',
    });
  });

  it('a pre-existing gap never blocks anyone', () => {
    // A3 is already stranded between A2 and A4. Taking A6–A8 creates nothing new (90 % occupancy).
    const taken = takenSet('A1', 'A2', 'A4', 'A5', 'A9', 'A10');
    expect(checkSeatGap(room(), taken, ['A6', 'A7', 'A8'], FAR, demand)).toEqual({ ok: true, reason: 'no_gap' });
  });

  it('aisles, row ends and inactive seats are never neighbours', () => {
    // Aisle between A3 and A4: choosing A2 next to taken A4 leaves A3 bordered by an aisle.
    const aisle = room({ aisleAfter: 3 });
    expect(checkSeatGap(aisle, takenSet('A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'), ['A2'], FAR, demand)).toEqual({ ok: true, reason: 'no_gap' });
    // Row end: A1 with A2 taken is not a gap.
    expect(checkSeatGap(room(), takenSet('A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'), ['A2'], FAR, demand).ok).toBe(true);
    // Inactive A3: choosing A2 next to it creates no gap.
    expect(checkSeatGap(room({ inactive: [3] }), takenSet('A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'), ['A1'], FAR, demand)).toEqual({ ok: true, reason: 'no_gap' });
  });

  it("'off' never evaluates; 'always' ignores occupancy but still lifts near the start", () => {
    expect(checkSeatGap(room(), busyRow, ['A4'], FAR, { ...demand, policy: 'off' })).toEqual({ ok: true, reason: 'policy_off' });
    const quiet = takenSet('A2', 'A6');
    expect(checkSeatGap(room({ rows: 2 }), quiet, ['A4'], FAR, { ...demand, policy: 'always' }).ok).toBe(false);
    expect(checkSeatGap(room({ rows: 2 }), quiet, ['A4'], 10, { ...demand, policy: 'always' }).ok).toBe(true);
  });

  it('suggests a block of the same size, preferring the same row, nearest first', () => {
    // A3..A6 free. The middle pair A4,A5 strands A3 and A6; A3,A4 (or A5,A6) strands nothing.
    const v = checkSeatGap(room(), takenSet('A1', 'A2', 'A7', 'A8', 'A9', 'A10'), ['A4', 'A5'], FAR, { ...demand, occupancyThreshold: 0 });
    expect(v).toEqual({ ok: false, gapSeatIds: ['A3', 'A6'], suggestion: ['A3', 'A4'] });
  });
});
