import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { meteringUsage } from '../db/schema/platform';
import { tenant } from '../db/schema/tenant';
import { ControlDb } from '../tenancy/control-db.provider';

export interface UsageRow {
  tenantId: string;
  period: string;
  requests: number;
  holdSeconds: number;
  bookings: number;
  tickets: number;
  storageBytes: number | null; // null = not measured this run: keep the last value
}

/**
 * Reads and writes ONLY platform.metering_usage and the tenant registry, on
 * the cinechain_control connection. That role has no grant on booking, ticket
 * or payment (pinned by test/isolation/control-grants.spec.ts), so this
 * repository could not select from them even if someone wrote the query.
 */
@Injectable()
export class MeteringRepository {
  constructor(private readonly db: ControlDb) {}

  async tenantIds(): Promise<string[]> {
    return (await this.db.platformTx((tx) => tx.select({ id: tenant.id }).from(tenant))).map((r) => r.id);
  }

  async upsert(rows: UsageRow[]): Promise<void> {
    if (!rows.length) return;
    await this.db.platformTx(async (tx) => {
      for (const r of rows)
        await tx
          .insert(meteringUsage)
          .values({ tenantId: r.tenantId, period: r.period, requests: r.requests, holdSeconds: r.holdSeconds, bookings: r.bookings, tickets: r.tickets, storageBytes: r.storageBytes ?? 0 })
          .onConflictDoUpdate({
            target: [meteringUsage.tenantId, meteringUsage.period],
            set: {
              requests: sql`excluded.requests`,
              holdSeconds: sql`excluded.hold_seconds`,
              bookings: sql`excluded.bookings`,
              tickets: sql`excluded.tickets`,
              storageBytes: r.storageBytes === null ? sql`${meteringUsage.storageBytes}` : sql`excluded.storage_bytes`,
              updatedAt: sql`now()`,
            },
          });
    });
  }

  list(period: string) {
    return this.db.platformTx((tx) =>
      tx
        .select({
          tenant_id: meteringUsage.tenantId,
          slug: tenant.slug,
          period: meteringUsage.period,
          requests: meteringUsage.requests,
          storage_bytes: meteringUsage.storageBytes,
          hold_seconds: meteringUsage.holdSeconds,
          bookings: meteringUsage.bookings,
          tickets: meteringUsage.tickets,
          updated_at: meteringUsage.updatedAt,
        })
        .from(meteringUsage)
        .innerJoin(tenant, eq(tenant.id, meteringUsage.tenantId))
        .where(eq(meteringUsage.period, period))
        .orderBy(asc(tenant.slug)),
    );
  }
}
