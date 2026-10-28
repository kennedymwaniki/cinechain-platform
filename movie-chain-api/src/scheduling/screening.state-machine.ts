import type { ScreeningStatus } from '../db/schema/screening';

/**
 * DRAFT → PUBLISHED → CLOSED → COMPLETED, and CANCELLED from any live state.
 * Only PUBLISHED is sellable. COMPLETED and CANCELLED are terminal.
 */
const NEXT: Record<ScreeningStatus, readonly ScreeningStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['closed', 'cancelled'],
  closed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const canTransition = (from: ScreeningStatus, to: ScreeningStatus) => NEXT[from].includes(to);
export const isSellable = (s: ScreeningStatus) => s === 'published';
