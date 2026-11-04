import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { TENANT_TABLES, type TenantTable } from '../db/tenant-tables';
import { StorageService } from '../storage/storage.service';
import { db, runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';

/**
 * Children before parents (foreign keys are RESTRICT). Derived from the
 * schema, and checked against TENANT_TABLES before anything is deleted: a
 * table added to TENANT_TABLES but not placed here refuses to run, rather
 * than being silently left behind.
 */
export const DELETION_ORDER: readonly TenantTable[] = [
  'admission_event',
  'ticket',
  'loyalty_ledger',
  'payment_webhook_event',
  'payment_refund',
  'payment',
  'seat_lock',
  'booking',
  'outbox_event',
  'report_export',
  'idempotency_key',
  'audit_event',
  'staff_activation',
  'staff_theatre',
  'tenant_customer',
  'pricing_rule',
  'screening',
  'film',
  'seat',
  'screen',
  'theatre',
  'staff_user',
];

export function assertCoversEveryTenantTable(order: readonly string[] = DELETION_ORDER): void {
  const missing = TENANT_TABLES.filter((t) => !order.includes(t));
  const extra = order.filter((t) => !(TENANT_TABLES as readonly string[]).includes(t));
  if (missing.length || extra.length || new Set(order).size !== order.length)
    throw new Error(`deletion order does not match TENANT_TABLES (missing: ${missing.join(', ') || '-'}; unknown: ${extra.join(', ') || '-'})`);
}

export interface ExportedTable {
  table: TenantTable;
  rows: number;
  sha256: string;
  key: string;
}

export interface DeletedTable {
  table: TenantTable;
  before: number;
  deleted: number;
  remaining: number;
}

const BATCH = 5_000;
/** Table names come ONLY from the reviewed constant, never from input. */
const ident = (t: TenantTable) => sql.raw(`"${t}"`);

const serialise = (row: Record<string, unknown>) =>
  JSON.stringify(row, (_k, v: unknown) => (Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : v));

/**
 * The tenant's data, in the APPLICATION plane, as cinechain_app, inside the
 * tenant's own scope: RLS decides which rows exist. That is the point — the
 * export cannot include another chain's row and the deletion cannot remove
 * one, whatever this code gets wrong. (The control plane cannot do either:
 * its role has no grant on booking, ticket or payment.)
 */
@Injectable()
export class TenantData {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly storage: StorageService,
  ) {}

  private scope<T>(ctx: TenantContext, fn: () => Promise<T>) {
    return runWithTenant(ctx, () => this.tenantDb.withTenantScope(fn));
  }

  private async count(ctx: TenantContext, t: TenantTable): Promise<number> {
    return this.scope(ctx, async () => Number((await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${ident(t)}`)).rows[0]!.n));
  }

  /** Every tenant table as JSONL under t/<tenant>/offboarding/export/, with a manifest. */
  async export(ctx: TenantContext): Promise<ExportedTable[]> {
    const manifest: ExportedTable[] = [];
    for (const t of TENANT_TABLES) {
      const rows = await this.scope(ctx, async () => (await db().execute<Record<string, unknown>>(sql`SELECT * FROM ${ident(t)}`)).rows);
      const body = Buffer.from(rows.map(serialise).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      const key = await this.storage.putObject(ctx.tenantId, ['offboarding', 'export', `${t}.jsonl`], body, 'application/x-ndjson');
      manifest.push({ table: t, rows: rows.length, sha256: createHash('sha256').update(body).digest('hex'), key });
    }
    await this.storage.putObject(ctx.tenantId, ['offboarding', 'export', 'manifest.json'], Buffer.from(JSON.stringify(manifest, null, 1)), 'application/json');
    return manifest;
  }

  /**
   * Ordered deletion in SHORT batches (one transaction per batch), so no lock
   * is held long enough to slow another tenant. No WHERE tenant_id anywhere:
   * RLS scopes every statement to this tenant. Counts before and after come
   * from fresh transactions.
   */
  async delete(ctx: TenantContext): Promise<DeletedTable[]> {
    assertCoversEveryTenantTable();
    const out: DeletedTable[] = [];
    for (const t of DELETION_ORDER) {
      const before = await this.count(ctx, t);
      let deleted = 0;
      for (;;) {
        const n = await this.scope(ctx, async () =>
          Number((await db().execute(sql`DELETE FROM ${ident(t)} WHERE ctid IN (SELECT ctid FROM ${ident(t)} LIMIT ${BATCH})`)).rowCount ?? 0),
        );
        deleted += n;
        if (n < BATCH) break;
      }
      out.push({ table: t, before, deleted, remaining: await this.count(ctx, t) });
    }
    return out;
  }

  /** The table counts alone (for a report re-check). */
  async counts(ctx: TenantContext): Promise<Record<TenantTable, number>> {
    const out = {} as Record<TenantTable, number>;
    for (const t of TENANT_TABLES) out[t] = await this.count(ctx, t);
    return out;
  }
}
