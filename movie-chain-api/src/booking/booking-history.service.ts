import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { tenantCustomer } from '../db/schema/tenant-customer';
import { Doors } from '../tenancy/doors';
import { toSystemContext } from '../tenancy/system-context';
import { db, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { BookingService } from './booking.service';

/**
 * FR-76 and FR-78, across chains. RLS holds one tenant per transaction, so:
 * the door returns POINTERS (tenant, booking id) for the consumer id taken
 * from the VERIFIED token; each tenant's rows are then read in that tenant's
 * own short scope, under RLS. The consumer id is never in a response.
 */
@Injectable()
export class BookingHistoryService {
  constructor(
    private readonly doors: Doors,
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly bookings: BookingService,
  ) {}

  async list(consumerId: string, before: Date, limit: number) {
    const refs = await this.doors.consumerBookingRefs(consumerId, before, limit);
    const byTenant = new Map<string, string[]>();
    for (const r of refs) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r.bookingId]);

    const items: (Awaited<ReturnType<BookingService['view']>> & { chain: { slug: string; name: string } })[] = [];
    for (const [tenantId, ids] of byTenant) {
      const chain = await this.registry.byId(tenantId);
      if (!chain) continue;
      const views = await runWithTenant(toSystemContext({ tenantId }, { kind: 'consumer', consumerId }), () =>
        this.tenantDb.withTenantScope(async () => Promise.all(ids.map((id) => this.bookings.view(id)))),
      );
      for (const v of views) items.push({ ...v, chain: { slug: chain.slug, name: chain.name } });
    }
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const last = refs.length === limit ? refs[refs.length - 1] : undefined;
    return { items, next_before: last ? last.createdAt.toISOString() : null };
  }

  /** Loyalty per chain: one login, independent balances. */
  async loyalty(consumerId: string) {
    const refs = await this.doors.consumerBookingRefs(consumerId, new Date(), 50);
    const out: { chain: { slug: string; name: string }; points: number }[] = [];
    for (const tenantId of new Set(refs.map((r) => r.tenantId))) {
      const chain = await this.registry.byId(tenantId);
      if (!chain) continue;
      const rows = await runWithTenant(toSystemContext({ tenantId }, { kind: 'consumer', consumerId }), () =>
        this.tenantDb.withTenantScope(() =>
          db().select({ points: tenantCustomer.loyaltyPoints }).from(tenantCustomer).where(eq(tenantCustomer.consumerId, consumerId)),
        ),
      );
      const points = rows.reduce((a, r) => a + r.points, 0);
      if (rows.length) out.push({ chain: { slug: chain.slug, name: chain.name }, points });
    }
    return { balances: out };
  }
}
