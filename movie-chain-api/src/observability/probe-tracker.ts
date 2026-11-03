/**
 * "Cross-tenant attempt > 10/min from one user" without a per-user label
 * (unbounded cardinality): keep a 60 s sliding window per (tenant, actor) in
 * memory and export only the BUSIEST actor's count, per tenant.
 */
export class ProbeTracker {
  private readonly hits = new Map<string, number[]>(); // `${tenant}|${actor}` → timestamps

  constructor(private readonly windowMs = 60_000) {}

  /** Records one attempt; returns the busiest actor's count in the window for that tenant. */
  record(tenant: string, actor: string, now = Date.now()): number {
    const key = `${tenant}|${actor}`;
    this.hits.set(key, [...(this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs), now]);
    if (this.hits.size > 10_000) this.prune(now);
    return this.maxFor(tenant, now);
  }

  maxFor(tenant: string, now = Date.now()): number {
    let max = 0;
    for (const [key, ts] of this.hits)
      if (key.startsWith(`${tenant}|`)) max = Math.max(max, ts.filter((t) => now - t < this.windowMs).length);
    return max;
  }

  private prune(now: number): void {
    for (const [k, ts] of this.hits) if (!ts.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}
