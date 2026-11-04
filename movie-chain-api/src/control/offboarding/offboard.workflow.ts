import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { conflict, notFound } from '../../common/errors/api-error';
import { offboardingRun } from '../../db/schema/platform';
import { tenant } from '../../db/schema/tenant';
import { TENANT_TABLES } from '../../db/tenant-tables';
import { LIFECYCLE_QUEUE, type LifecycleAction, type LifecycleJob } from '../../lifecycle/lifecycle.processor';
import type { DeletedTable, ExportedTable } from '../../lifecycle/tenant-data';
import { MeteringAggregator } from '../../metering/aggregator.processor';
import { StorageService } from '../../storage/storage.service';
import { ControlDb } from '../../tenancy/control-db.provider';
import { toSystemContext } from '../../tenancy/system-context';
import { runWithTenant } from '../../tenancy/tenant-context';
import { type DeletionReport, DeletionReportSigner, isExportManifest } from './deletion-report';
import { DeletionService } from './deletion.service';

export const OFFBOARDING_DEADLINE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Suspend, reactivate, and ACTIVE → OFFBOARDING → EXPORTED → DELETED (FR-6,
 * FR-8). Every call to `advance` moves one step and is safe to repeat: the
 * state lives in platform.offboarding_run and the application-plane work runs
 * as jobs with FIXED ids, so a crash anywhere resumes rather than redoes.
 * The export is verified — re-read from storage, hashed, counted — BEFORE any
 * deletion begins.
 */
@Injectable()
export class OffboardWorkflow {
  private readonly log = new Logger(OffboardWorkflow.name);

  constructor(
    private readonly db: ControlDb,
    @InjectQueue(LIFECYCLE_QUEUE) private readonly lifecycle: Queue<LifecycleJob>,
    private readonly storage: StorageService,
    private readonly deletion: DeletionService,
    private readonly signer: DeletionReportSigner,
    private readonly metering: MeteringAggregator,
  ) {}

  // ----------------------------------------------------------------- suspend
  /** Logins blocked, live holds released, confirmed bookings honoured, all data kept. */
  async suspend(tenantId: string) {
    const [t] = await this.db.platformTx((tx) => tx.update(tenant).set({ status: 'suspended' }).where(and(eq(tenant.id, tenantId), eq(tenant.status, 'active'))).returning({ id: tenant.id }));
    if (!t) await this.assertStatus(tenantId, ['suspended']);
    const job = await this.ensureJob(tenantId, 'release-holds', `suspend-${Date.now()}`);
    return { tenant_id: tenantId, status: 'suspended', holds_release_job: job.id };
  }

  async reactivate(tenantId: string) {
    const [t] = await this.db.platformTx((tx) => tx.update(tenant).set({ status: 'active' }).where(and(eq(tenant.id, tenantId), eq(tenant.status, 'suspended'))).returning({ id: tenant.id }));
    if (!t) await this.assertStatus(tenantId, ['active']);
    return { tenant_id: tenantId, status: 'active' };
  }

  // ----------------------------------------------------------------- offboard
  async start(tenantId: string, operatorId: string, now = new Date()) {
    await this.db.platformTx(async (tx) => {
      const [t] = await tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, tenantId)).for('update');
      if (!t) throw notFound();
      if (t.status === 'deleted') throw conflict('already_offboarded', 'This tenant has been offboarded');
      await tx
        .insert(offboardingRun)
        .values({ tenantId, requestedBy: operatorId, requestedAt: now, deadlineAt: new Date(now.getTime() + OFFBOARDING_DEADLINE_DAYS * DAY_MS) })
        .onConflictDoNothing();
      // Everything stops: the door admits only ACTIVE chains, logins refuse anything else.
      await tx.update(tenant).set({ status: 'offboarding' }).where(eq(tenant.id, tenantId));
    });
    await this.ensureJob(tenantId, 'release-holds', 'offboard');
    return this.advance(tenantId);
  }

  /** One step forward, if one is ready. Repeatable. */
  async advance(tenantId: string) {
    const run = await this.run(tenantId);
    try {
      if (run.status === 'offboarding') await this.stepExport(tenantId);
      else if (run.status === 'exported') await this.stepDelete(tenantId, run);
    } catch (e) {
      await this.db.platformTx((tx) => tx.update(offboardingRun).set({ lastError: (e as Error).message.slice(0, 500), updatedAt: new Date() }).where(eq(offboardingRun.tenantId, tenantId)));
      throw e;
    }
    return this.summary(tenantId);
  }

  /** Runs that are not finished: the tick's input. */
  async pending(): Promise<string[]> {
    return (await this.db.platformTx((tx) => tx.select({ id: offboardingRun.tenantId }).from(offboardingRun).where(ne(offboardingRun.status, 'deleted')))).map((r) => r.id);
  }

  private async stepExport(tenantId: string) {
    const job = await this.ensureJob(tenantId, 'export', 'offboard');
    const state = await job.getState();
    if (state === 'failed') {
      await job.retry();
      throw new Error(`export job failed: ${job.failedReason}`);
    }
    if (state !== 'completed') return;
    const manifest = (job.returnvalue as { manifest?: unknown } | undefined)?.manifest;
    if (!isExportManifest(manifest)) throw new Error('export job returned no manifest');
    try {
      await this.verifyExport(tenantId, manifest);
    } catch (e) {
      // Nothing is deleted on a bad export. Discard it, so the next advance exports afresh.
      await job.remove();
      throw e;
    }
    await this.db.platformTx((tx) =>
      tx
        .update(offboardingRun)
        .set({ status: 'exported', exportManifest: manifest, exportVerifiedAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(and(eq(offboardingRun.tenantId, tenantId), eq(offboardingRun.status, 'offboarding'))),
    );
    await this.inContext(tenantId, () => this.log.log('export verified; deletion may begin'));
  }

  /**
   * The export must be COMPLETE and READABLE before anything is deleted:
   * every tenant table present, every file re-read from storage, its SHA-256
   * and row count matching the manifest.
   */
  private async verifyExport(tenantId: string, manifest: ExportedTable[]) {
    const missing = TENANT_TABLES.filter((t) => !manifest.some((m) => m.table === t));
    if (missing.length) throw new Error(`export is missing ${missing.join(', ')}`);
    const prefix = StorageService.tenantKey(tenantId, ['x']).slice(0, -1);
    for (const m of manifest) {
      if (!m.key.startsWith(prefix)) throw new Error(`export key ${m.key} is outside the tenant prefix`);
      const bytes = await this.storage.getObjectBytes(m.key);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const rows = bytes.length ? bytes.toString('utf8').split('\n').filter(Boolean).length : 0;
      if (sha !== m.sha256 || rows !== m.rows) throw new Error(`export of ${m.table} does not verify (sha or row count differs)`);
    }
  }

  private async stepDelete(tenantId: string, run: typeof offboardingRun.$inferSelect) {
    // Fold the tenant's last usage into metering BEFORE its counters are deleted with its Redis keys.
    await this.metering.aggregate();
    const job = await this.ensureJob(tenantId, 'delete', 'offboard');
    const state = await job.getState();
    if (state === 'failed') {
      await job.retry();
      throw new Error(`deletion job failed: ${job.failedReason}`);
    }
    if (state !== 'completed') return;
    const tables = (job.returnvalue as { tables?: DeletedTable[] } | undefined)?.tables ?? [];

    const redis = await this.deletion.redisKeys(tenantId);
    const queues = await this.deletion.queuedJobs(tenantId);
    const objects = await this.deletion.objects(tenantId);
    const manifest = run.exportManifest as ExportedTable[];
    const now = new Date();
    const report: DeletionReport = {
      tenant_id: tenantId,
      requested_at: run.requestedAt.toISOString(),
      completed_at: now.toISOString(),
      deadline_at: run.deadlineAt.toISOString(),
      export: {
        tables: manifest.length,
        rows: manifest.reduce((a, m) => a + m.rows, 0),
        verified_at: run.exportVerifiedAt!.toISOString(),
        retained_until: run.deadlineAt.toISOString(),
        keys: manifest.map((m) => m.key),
      },
      tables: TENANT_TABLES.map((t) => tables.find((x) => x.table === t) ?? { table: t, before: -1, deleted: 0, remaining: -1 }),
      redis,
      queues,
      objects,
      retained: [
        'tenant registry row, as a tombstone (status deleted): referenced by invoices',
        'platform.invoice, invoice_line, metering_usage, subscription: billing records kept for accounting',
        'platform.consumer: belongs to the person, not the chain — untouched',
        `the export under t/${tenantId}/offboarding/export/, until ${run.deadlineAt.toISOString().slice(0, 10)}`,
      ],
      complete: false,
    };
    report.complete = report.tables.every((t) => t.remaining === 0) && redis.remaining === 0 && queues.remaining === 0 && objects.remaining_outside_export === 0;
    if (!report.complete) throw new Error('deletion is not complete: see the report counts');

    const signature = await this.signer.sign(report);
    await this.storage.putAuditObject(['offboarding', `${tenantId}.json`], Buffer.from(JSON.stringify({ report, signature }, null, 1)), 'application/json');
    await this.db.platformTx(async (tx) => {
      await tx
        .update(offboardingRun)
        .set({ status: 'deleted', report, reportSignature: signature, completedAt: now, lastError: null, updatedAt: now })
        .where(and(eq(offboardingRun.tenantId, tenantId), eq(offboardingRun.status, 'exported')));
      await tx.update(tenant).set({ status: 'deleted' }).where(eq(tenant.id, tenantId));
    });
    await this.inContext(tenantId, () => this.log.log('offboarding complete: every table emptied, report signed and archived'));
  }

  async summary(tenantId: string) {
    const run = await this.run(tenantId);
    return {
      tenant_id: tenantId,
      status: run.status,
      requested_at: run.requestedAt,
      deadline_at: run.deadlineAt,
      export_verified_at: run.exportVerifiedAt,
      completed_at: run.completedAt,
      last_error: run.lastError,
    };
  }

  async report(tenantId: string) {
    const run = await this.run(tenantId);
    if (!run.report) return { tenant_id: tenantId, status: run.status, tables: [], signature: null };
    return { ...(run.report as DeletionReport), status: run.status, signature: run.reportSignature };
  }

  private async run(tenantId: string) {
    const [r] = await this.db.platformTx((tx) => tx.select().from(offboardingRun).where(eq(offboardingRun.tenantId, tenantId)));
    if (!r) throw notFound();
    return r;
  }

  /** A FIXED job id per (tenant, action, purpose): enqueueing again returns the same job. Results are kept. */
  private async ensureJob(tenantId: string, action: LifecycleAction, purpose: string): Promise<Job<LifecycleJob>> {
    const id = `${purpose}-${action}-${tenantId}`;
    const existing = await this.lifecycle.getJob(id);
    if (existing) return existing;
    return this.lifecycle.add(action, { tenantId, action }, { jobId: id, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: false, removeOnFail: false });
  }

  /** Log lines carry tenant_id from the context (step 23), never from the call site. */
  private inContext(tenantId: string, fn: () => void): Promise<void> {
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason: 'offboarding' }), async () => fn());
  }

  private async assertStatus(tenantId: string, ok: string[]) {
    const [t] = await this.db.platformTx((tx) => tx.select({ status: tenant.status }).from(tenant).where(and(eq(tenant.id, tenantId), inArray(tenant.status, ok as never[]))));
    if (!t) {
      const [exists] = await this.db.platformTx((tx) => tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, tenantId)));
      if (!exists) throw notFound();
      throw conflict('invalid_state', `A ${exists.status} tenant cannot do that`);
    }
  }
}
