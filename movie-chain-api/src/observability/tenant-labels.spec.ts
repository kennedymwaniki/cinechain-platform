import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.module';
import { OTHER, TenantLabels } from './tenant-labels';

describe('tenant label cardinality guard', () => {
  it('a synthetic flood of 200 tenants produces at most 51 label values', () => {
    const labels = new TenantLabels();
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) for (let i = 0; i < 200; i++) seen.add(labels.label(`t-${i}`));
    expect(seen.size).toBeLessThanOrEqual(51);
    expect(seen.has(OTHER)).toBe(true);
  });

  it('the busiest tenants earn their own label on re-rank', () => {
    const labels = new TenantLabels(2, Number.MAX_SAFE_INTEGER);
    labels.label('quiet-1');
    labels.label('quiet-2');
    for (let i = 0; i < 100; i++) labels.label('busy');
    expect(labels.label('busy')).toBe(OTHER);
    labels.rerank();
    expect(labels.label('busy')).toBe('busy');
  });

  it('through the metrics registry: 200 tenants, at most 51 tenant values on a series', async () => {
    const m = new Metrics();
    for (let i = 0; i < 200; i++) m.observe('hold.acquire_seconds', { tenant: crypto.randomUUID(), path: 'redis' }, 0.01);
    const text = await m.render();
    const values = new Set([...text.matchAll(/cinechain_hold_acquire_seconds_count\{[^}]*tenant="([^"]+)"/g)].map((x) => x[1]));
    expect(values.size).toBeLessThanOrEqual(51);
    expect(text).toMatch(/cinechain_hold_acquire_seconds_bucket\{[^}]*tenant="other"/);
  });
});
