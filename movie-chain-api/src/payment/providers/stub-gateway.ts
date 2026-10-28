import { randomUUID } from 'node:crypto';
import type { Money } from '../../shared/money';

export type StubBehaviour = 'approve' | 'decline' | 'timeout' | 'unknown';

interface Charge {
  ref: string;
  key: string;
  amount: Money;
  outcome: 'captured' | 'failed' | 'pending';
  last4?: string | undefined;
  refunded: number;
}

/**
 * The provider's side of the wire, in-process. Real integrations (Daraja STK
 * push, a card processor's hosted fields) replace this; the providers and
 * everything above them do not change. Like a real provider it dedupes on the
 * idempotency key, and it keeps a CALL LOG so tests can prove a retry was
 * never a second charge.
 */
export class StubGateway {
  readonly calls: { op: 'charge' | 'status' | 'refund'; key: string }[] = [];
  private readonly charges = new Map<string, Charge>();
  private readonly refunds = new Map<string, string>();
  /** The next charge's outcome. Tests set it; it resets to approve after use. */
  next: StubBehaviour = 'approve';
  /** What a 'timeout' charge eventually became, revealed by status(). */
  timeoutResolvesTo: 'captured' | 'failed' = 'captured';

  charge(key: string, amount: Money, last4?: string): { ref: string; outcome: 'captured' | 'failed' | 'pending' | 'timeout' } {
    this.calls.push({ op: 'charge', key });
    const prior = this.charges.get(key);
    if (prior) return { ref: prior.ref, outcome: prior.outcome }; // idempotent: never charged twice
    const behaviour = this.next;
    this.next = 'approve';
    const ref = `stub_${randomUUID()}`;
    const outcome = behaviour === 'approve' ? 'captured' : behaviour === 'decline' ? 'failed' : 'pending';
    this.charges.set(key, { ref, key, amount, outcome, last4, refunded: 0 });
    if (behaviour === 'timeout') {
      // The charge DID go through on the provider's side; our caller just never heard.
      this.charges.get(key)!.outcome = this.timeoutResolvesTo;
      return { ref, outcome: 'timeout' };
    }
    return { ref, outcome };
  }

  lookup(key: string) {
    this.calls.push({ op: 'status', key });
    return this.charges.get(key) ?? null;
  }

  refund(key: string, ref: string, amount: Money): { refundRef: string } | { error: string } {
    this.calls.push({ op: 'refund', key });
    const prior = this.refunds.get(key);
    if (prior) return { refundRef: prior };
    const charge = [...this.charges.values()].find((c) => c.ref === ref);
    if (!charge || charge.outcome !== 'captured') return { error: 'no such capture' };
    if (charge.refunded + amount.amountMinor > charge.amount.amountMinor) return { error: 'refund exceeds capture' };
    charge.refunded += amount.amountMinor;
    const refundRef = `stubrf_${randomUUID()}`;
    this.refunds.set(key, refundRef);
    return { refundRef };
  }

  /** Moves a pending charge to its final state (what the provider's callback reports). */
  settle(ref: string, outcome: 'captured' | 'failed'): void {
    const c = [...this.charges.values()].find((x) => x.ref === ref);
    if (c) c.outcome = outcome;
  }

  chargeCount(key: string): number {
    return this.charges.has(key) ? 1 : 0;
  }
}
