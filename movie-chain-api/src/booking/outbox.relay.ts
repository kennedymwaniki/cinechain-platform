import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { outboxEvent } from '../db/schema/booking';
import { db, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';

export type OutboxHandler = (tenantId: string, payload: Record<string, unknown>) => Promise<void>;

/**
 * Drains outbox rows AFTER the transaction that wrote them has committed.
 * Handlers (the live seat map, notifications — step 21) subscribe by kind. A
 * row is marked processed only once every handler for it has succeeded, so a
 * failure leaves it for the next drain rather than losing it.
 */
@Injectable()
export class OutboxRelay {
  private readonly log = new Logger(OutboxRelay.name);
  private readonly handlers = new Map<string, OutboxHandler[]>();

  constructor(private readonly tenantDb: TenantDb) {}

  on(kind: string, handler: OutboxHandler): void {
    this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), handler]);
  }

  async drain(ctx: TenantContext, ids: number[]): Promise<void> {
    if (!ids.length) return;
    const scope = <T>(fn: () => Promise<T>) => runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));
    const rows = await scope(() =>
      db()
        .select()
        .from(outboxEvent)
        .where(and(inArray(outboxEvent.id, ids), isNull(outboxEvent.processedAt))),
    );
    for (const row of rows) {
      try {
        for (const h of this.handlers.get(row.kind) ?? []) await h(ctx.tenantId, row.payload);
        await scope(() => db().update(outboxEvent).set({ processedAt: new Date() }).where(eq(outboxEvent.id, row.id)));
      } catch (e) {
        // Never fails the request that wrote it: the sale has already committed.
        this.log.warn(`outbox ${row.kind}#${row.id} not delivered: ${(e as Error).message}`);
      }
    }
  }
}
