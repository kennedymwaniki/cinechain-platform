import { Injectable } from '@nestjs/common';
import { AuditLog } from '../audit/audit-log.service';
import { badRequest, conflict } from '../common/errors/api-error';
import type { PricingRule } from '../db/schema/catalogue';
import type { ScreenFormat, SeatClass } from '../db/schema/venue';
import type { Money } from '../shared/money';
import { currentTenant } from '../tenancy/tenant-context';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { CatalogueRepository } from './catalogue.repository';
import { resolvePrice } from './price-resolver';

/** Tolerance for "now" between the client and the server clock. */
const CLOCK_SKEW_MS = 60_000;

export const ruleView = (r: PricingRule) => ({
  id: r.id,
  seat_class: r.seatClass,
  format: r.format,
  price: { amount_minor: r.priceMinor, currency: r.currency },
  effective_from: r.effectiveFrom,
  effective_to: r.effectiveTo,
});

@Injectable()
export class PricingService {
  constructor(
    private readonly repo: CatalogueRepository,
    private readonly registry: TenantRegistry,
    private readonly audit: AuditLog,
  ) {}

  async list() {
    return (await this.repo.listRules()).map(ruleView);
  }

  /**
   * Prices change FORWARD only. A new rule starts now or later, and closes
   * the rule it replaces at that instant, so every past instant keeps the
   * price it had. Overlaps are refused by the database's exclusion
   * constraint; the steps below just produce the right one on purpose.
   */
  async create(v: { seatClass: SeatClass; format: ScreenFormat | null; priceMinor: number; effectiveFrom: Date | null }) {
    const now = new Date();
    const from = v.effectiveFrom ?? now;
    if (from.getTime() < now.getTime() - CLOCK_SKEW_MS)
      throw badRequest('retroactive_price', 'A price cannot start in the past; prices never apply retroactively');

    const tenant = await this.registry.byId(currentTenant().tenantId);
    const existing = await this.repo.rulesFrom(v.seatClass, v.format, from);
    if (existing.some((r) => r.effectiveFrom.getTime() >= from.getTime()))
      throw conflict('price_already_scheduled', 'A price for this seat class already starts at or after that time');
    for (const r of existing) await this.repo.closeRule(r.id, from);

    const rule = await this.repo.insertRule({
      seatClass: v.seatClass,
      format: v.format,
      priceMinor: v.priceMinor,
      currency: tenant!.currency,
      effectiveFrom: from,
      createdBy: actorId(),
    });
    await this.audit.record('pricing_rule.created', 'pricing_rule', rule.id, {
      seat_class: v.seatClass,
      format: v.format,
      price_minor: v.priceMinor,
      replaces: existing.map((r) => r.id),
    });
    return ruleView(rule);
  }

  /** The price of one seat class at one instant (step 13 prices holds with this). */
  async priceFor(seatClass: SeatClass, format: ScreenFormat, at: Date): Promise<Money | null> {
    return resolvePrice(await this.repo.rulesCovering(at), seatClass, format, at);
  }
}

function actorId(): string | null {
  const a = currentTenant().actor;
  return a.kind === 'staff' ? a.userId : null;
}
