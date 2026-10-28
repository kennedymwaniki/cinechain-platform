import { describe, expect, it } from 'vitest';
import { SCREENING_STATUSES } from '../db/schema/screening';
import { canTransition, isSellable } from './screening.state-machine';

describe('screening state machine', () => {
  it('allows exactly the documented transitions', () => {
    const allowed = SCREENING_STATUSES.flatMap((f) => SCREENING_STATUSES.filter((t) => canTransition(f, t)).map((t) => `${f}→${t}`));
    expect(allowed.sort()).toEqual(
      ['closed→cancelled', 'closed→completed', 'draft→cancelled', 'draft→published', 'published→cancelled', 'published→closed'].sort(),
    );
  });
  it('rejects illegal moves: back to draft, out of a terminal state, skipping publish', () => {
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('cancelled', 'published')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('draft', 'closed')).toBe(false);
  });
  it('only PUBLISHED is sellable', () => {
    expect(SCREENING_STATUSES.filter(isSellable)).toEqual(['published']);
  });
});
