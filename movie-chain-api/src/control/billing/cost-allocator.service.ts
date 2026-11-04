import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { infraCost, tenantCostAllocation } from '../../db/schema/billing';
import { meteringUsage } from '../../db/schema/platform';
import { tenant } from '../../db/schema/tenant';
import { notFound } from '../../common/errors/api-error';
import { ControlDb } from '../../tenancy/control-db.provider';
import { allocateCost, DRIVERS } from './cost-model';

@Injectable()
export class CostAllocator {
  constructor(private readonly db: ControlDb) {}

  recordBill(v: { period: string; currency: string; totalMinor: number; source: string }) {
    return this.db.platformTx((tx) =>
      tx
        .insert(infraCost)
        .values(v)
        .onConflictDoUpdate({ target: infraCost.period, set: { currency: v.currency, totalMinor: v.totalMinor, source: v.source, recordedAt: new Date() } })
        .returning(),
    );
  }

  /** Apportions the period's bill by consumption share and stores it (replacing any earlier run). */
  async allocate(period: string) {
    await this.db.platformTx(async (tx) => {
      const [bill] = await tx.select().from(infraCost).where(eq(infraCost.period, period));
      if (!bill) throw notFound();
      const usage = await tx.select().from(meteringUsage).where(eq(meteringUsage.period, period)).orderBy(asc(meteringUsage.tenantId));
      const alloc = allocateCost(
        bill.totalMinor,
        usage.map((u) => ({ tenantId: u.tenantId, usage: { requests: u.requests, hold_seconds: u.holdSeconds, storage_bytes: u.storageBytes, tickets: u.tickets } })),
      );
      await tx.delete(tenantCostAllocation).where(eq(tenantCostAllocation.period, period));
      if (alloc.length)
        await tx.insert(tenantCostAllocation).values(
          alloc.map((a) => {
            const u = usage.find((x) => x.tenantId === a.tenantId)!;
            return {
              period,
              tenantId: a.tenantId,
              currency: bill.currency,
              allocatedMinor: a.allocatedMinor,
              sharePpm: a.sharePpm,
              drivers: { requests: u.requests, hold_seconds: u.holdSeconds, storage_bytes: u.storageBytes, tickets: u.tickets },
            };
          }),
        );
    });
    // Read AFTER the commit: view() runs on its own connection and cannot see uncommitted rows.
    return this.view(period);
  }

  async view(period: string) {
    return this.db.platformTx(async (tx) => {
      const [bill] = await tx.select().from(infraCost).where(eq(infraCost.period, period));
      if (!bill) throw notFound();
      const rows = await tx
        .select({ tenant_id: tenantCostAllocation.tenantId, slug: tenant.slug, share_ppm: tenantCostAllocation.sharePpm, allocated_minor: tenantCostAllocation.allocatedMinor, drivers: tenantCostAllocation.drivers })
        .from(tenantCostAllocation)
        .innerJoin(tenant, eq(tenant.id, tenantCostAllocation.tenantId))
        .where(eq(tenantCostAllocation.period, period))
        .orderBy(asc(tenant.slug));
      const allocated = rows.reduce((a, r) => a + r.allocated_minor, 0);
      return {
        period,
        currency: bill.currency,
        total_minor: bill.totalMinor,
        allocated_minor: allocated,
        unallocated_minor: bill.totalMinor - allocated, // 0 by construction (largest remainder)
        model: { drivers: DRIVERS, stated_accuracy: '±20 % (proxy apportionment of a pooled bill)', sum_tolerance_minor: 0 },
        tenants: rows,
      };
    });
  }
}
