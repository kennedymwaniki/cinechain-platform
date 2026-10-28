/** What the system knows about one seat at one screening. */
export type InternalSeatState = 'AVAILABLE' | 'HELD_BY_ME' | 'HELD_BY_OTHER' | 'SOLD' | 'REDEEMED';
/** All the public ever sees. */
export type ExternalSeatState = 'free' | 'taken' | 'yours';

export interface LockSnapshot {
  status: 'held' | 'sold';
  holdId: string | null;
  expiresAt: string | null; // ISO; null once sold
  redeemed?: boolean;
}

/**
 * Internal state of one seat, given its lock row (if any), the viewer's hold
 * id (if any) and the time. An expired hold is AVAILABLE: Redis TTL has
 * released it even if the sweeper has not yet deleted the durable row.
 */
export function internalState(lock: LockSnapshot | undefined, viewerHoldId: string | null, now: number): InternalSeatState {
  if (!lock) return 'AVAILABLE';
  if (lock.status === 'sold') return lock.redeemed ? 'REDEEMED' : 'SOLD';
  if (lock.expiresAt !== null && Date.parse(lock.expiresAt) <= now) return 'AVAILABLE';
  return viewerHoldId !== null && lock.holdId === viewerHoldId ? 'HELD_BY_ME' : 'HELD_BY_OTHER';
}

/**
 * The mask. "Held" and "sold" are deliberately indistinguishable outside: a
 * competitor watching which seats are merely being considered could read live
 * demand (PRD §7.6). Every state other than free or yours is "taken".
 */
export function toExternal(s: InternalSeatState): ExternalSeatState {
  switch (s) {
    case 'AVAILABLE':
      return 'free';
    case 'HELD_BY_ME':
      return 'yours';
    case 'HELD_BY_OTHER':
    case 'SOLD':
    case 'REDEEMED':
      return 'taken';
  }
}
