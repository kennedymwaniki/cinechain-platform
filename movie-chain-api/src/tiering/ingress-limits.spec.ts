import { describe, expect, it } from 'vitest';
import { renderIngressLimits } from './ingress-limits';

const TIERS = [
  { code: 'basic', rateLimitRps: 20 },
  { code: 'gold', rateLimitRps: 300 }, // a fifth-style tier: just another row
];
const TENANTS = [
  { slug: 'nyati', tier: 'basic', rateLimitRps: null },
  { slug: 'prestige', tier: 'gold', rateLimitRps: null },
  { slug: 'century', tier: 'basic', rateLimitRps: 75 }, // negotiated
];

describe('ingress limits mirror the tier table', () => {
  const conf = renderIngressLimits(TIERS, TENANTS, 'cinechain.app', 50);

  it('one zone per tier at exactly that tier’s rate, each tenant keyed by its slug', () => {
    expect(conf).toContain('limit_req_zone $cinechain_tier_basic_key zone=cinechain_tier_basic:10m rate=20r/s;');
    expect(conf).toContain('limit_req_zone $cinechain_tier_gold_key zone=cinechain_tier_gold:10m rate=300r/s;');
    expect(conf).toMatch(/map \$cinechain_slug \$cinechain_tier_basic_key \{\n {2}nyati nyati;\n {2}default "";/);
    expect(conf).toMatch(/map \$cinechain_slug \$cinechain_tier_gold_key \{\n {2}prestige prestige;/);
  });

  it('a negotiated limit gets its own zone and leaves the tier zone', () => {
    expect(conf).toContain('zone=cinechain_tenant_century:1m rate=75r/s;');
    expect(conf).not.toMatch(/cinechain_tier_basic_key \{[^}]*century/);
  });

  it('guests (no tenant at the edge) are limited per address; refusals are 429', () => {
    expect(conf).toContain('limit_req_zone $binary_remote_addr zone=cinechain_address:20m rate=50r/s;');
    expect(conf).toContain('limit_req_status 429;');
  });
});
