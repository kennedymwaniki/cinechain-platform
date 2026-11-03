/**
 * The cardinality guard. A `tenant` label per tenant is what makes the
 * noisy-neighbour alert possible, and 50 000 tenants × 20 metrics would melt
 * Prometheus. So: the ~50 busiest tenants keep their own label value (their
 * id), every other tenant is `other`. The ranking is recomputed from observed
 * volume, so a tenant that becomes busy earns its own series.
 */
export const MAX_TENANT_LABELS = 50;
export const OTHER = 'other';

export class TenantLabels {
  private readonly volume = new Map<string, number>();
  private labelled = new Set<string>();
  private lastRank = Date.now();

  constructor(
    private readonly max = MAX_TENANT_LABELS,
    private readonly rerankEveryMs = 5 * 60_000,
  ) {}

  /** The label value to use for this tenant right now. */
  label(tenantId: string | null | undefined): string {
    if (!tenantId) return 'none';
    this.volume.set(tenantId, (this.volume.get(tenantId) ?? 0) + 1);
    if (Date.now() - this.lastRank > this.rerankEveryMs) this.rerank();
    if (this.labelled.has(tenantId)) return tenantId;
    if (this.labelled.size < this.max) {
      this.labelled.add(tenantId);
      return tenantId;
    }
    return OTHER;
  }

  /** The label a tenant currently maps to, without counting it as traffic. */
  peek(tenantId: string | null | undefined): string {
    if (!tenantId) return 'none';
    return this.labelled.has(tenantId) ? tenantId : OTHER;
  }

  /** The busiest `max` tenants get their own label from now on. */
  rerank(): void {
    this.labelled = new Set([...this.volume.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.max).map(([t]) => t));
    // Decay, so a tenant that WAS busy last week does not hold a slot forever.
    for (const [t, n] of this.volume) {
      if (n > 1) this.volume.set(t, Math.floor(n / 2));
      else this.volume.delete(t);
    }
    this.lastRank = Date.now();
  }
}
