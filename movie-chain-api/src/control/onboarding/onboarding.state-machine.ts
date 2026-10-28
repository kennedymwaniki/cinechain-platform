/**
 * PENDING → PROVISIONING → ACTIVE
 *               │
 *               └→ FAILED ──(compensation completes)──→ ROLLED_BACK
 *
 * FAILED means compensation itself did not finish; a retry re-runs it.
 * ROLLED_BACK leaves no trace of the tenant; a retry starts a fresh run.
 */
export type RunStatus = 'pending' | 'provisioning' | 'active' | 'failed' | 'rolled_back';

const ALLOWED: Record<RunStatus, RunStatus[]> = {
  pending: ['provisioning', 'failed', 'rolled_back'],
  provisioning: ['provisioning', 'active', 'failed', 'rolled_back'],
  active: ['rolled_back'], // undo of a throwaway tenant (smoke test, DELETE /admin/tenants/:id)
  failed: ['rolled_back'],
  rolled_back: [],
};

export class IllegalTransitionError extends Error {}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!ALLOWED[from].includes(to)) throw new IllegalTransitionError(`onboarding run cannot go ${from} → ${to}`);
}
