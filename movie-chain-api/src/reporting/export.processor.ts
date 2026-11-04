import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type BeforeApplicationShutdown, Body, Controller, Get, Injectable, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { Roles } from '../auth/decorators';
import { notFound } from '../common/errors/api-error';
import { Uuid } from '../common/validation/uuid.pipe';
import { reportExport } from '../db/schema/reporting';
import { StorageService } from '../storage/storage.service';
import { toSystemContext } from '../tenancy/system-context';
import { currentTenant, db, runWithTenant } from '../tenancy/tenant-context';
import { toCsv } from './csv';
import { CreateExportDto } from './dto';
import { DeferTenantTransaction } from '../tenancy/decorators';
import { ReportingService } from './reporting.service';
import { ReportingRepository } from './reporting.repository';
import { Metrics } from '../observability/metrics.module';
import { TenantJobGate } from '../lifecycle/tenant-job-gate';

export const EXPORT_QUEUE = 'reporting.export';
export const EXPORT_LINK_TTL_S = 300;

export interface ExportJob {
  tenantId: string;
  exportId: string;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly reports: ReportingService,
    @InjectQueue(EXPORT_QUEUE) private readonly queue: Queue<ExportJob>,
    private readonly storage: StorageService,
  ) {}

  async request(v: { kind: 'revenue' | 'occupancy'; from: Date; to: Date }) {
    const { tenantId, actor } = currentTenant();
    const row = await this.reports.run(async () => {
      const [r] = await db()
        .insert(reportExport)
        .values({ tenantId, kind: v.kind, fromAt: v.from, toAt: v.to, requestedBy: actor.kind === 'staff' ? actor.userId : '' })
        .returning();
      return r!;
    });
    await this.queue.add('export', { tenantId, exportId: row.id }, { jobId: `export-${row.id}`, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true });
    return { export_id: row.id, status: row.status };
  }

  /** The download link is short-lived and signed; the object key is the tenant's own. */
  async status(id: string) {
    const row = await this.reports.run(async () => (await db().select().from(reportExport).where(eq(reportExport.id, id)))[0]);
    if (!row) throw notFound();
    return {
      export_id: row.id,
      kind: row.kind,
      status: row.status,
      rows: row.rows,
      download_url: row.status === 'ready' && row.objectKey ? await this.storage.getSignedUrlForKey(row.objectKey, EXPORT_LINK_TTL_S) : null,
      expires_in_s: row.status === 'ready' ? EXPORT_LINK_TTL_S : null,
    };
  }
}

/** FR-66. Tenant in the payload, runWithTenant first; reads on the REPORTING pool. */
@Processor(EXPORT_QUEUE)
export class ExportProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly reports: ReportingService,
    private readonly repo: ReportingRepository,
    private readonly storage: StorageService,
    private readonly gate: TenantJobGate,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true).catch(() => undefined);
  }

  async process(job: Job<ExportJob>, token?: string): Promise<string> {
    const { tenantId, exportId } = job.data;
    // Paused while the chain is suspended; dropped once it is offboarded (step 27).
    if ((await this.gate.check(job, token, tenantId)) === 'drop') return 'tenant offboarded';
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason: 'report export' }), async () => {
      const row = await this.reports.run(async () => (await db().select().from(reportExport).where(eq(reportExport.id, exportId)))[0]);
      if (!row || row.status !== 'pending') return 'nothing to do';
      try {
        const { csv, rows } =
          row.kind === 'revenue'
            ? await this.reports.run(async () => {
                const r = await this.repo.revenueByTheatre(row.fromAt, row.toAt);
                return { csv: toCsv(['theatre_id', 'theatre', 'bookings', 'tickets', 'total_minor'], r.map((x) => [x.theatre_id, x.theatre, x.bookings, x.tickets, x.total_minor])), rows: r.length };
              })
            : await this.reports.run(async () => {
                const r = await this.repo.occupancy(row.fromAt, row.toAt, null);
                return {
                  csv: toCsv(
                    ['screening_id', 'starts_at', 'theatre', 'screen', 'film', 'capacity', 'sold', 'held'],
                    r.map((x) => [x.screening_id, new Date(x.starts_at).toISOString(), x.theatre, x.screen, x.film, x.capacity, x.sold, x.held]),
                  ),
                  rows: r.length,
                };
              });
        // StorageService builds the key as t/<tenant_id>/…; the table's CHECK insists on it too.
        const key = await this.storage.putObject(tenantId, ['exports', `${row.kind}-${exportId}.csv`], Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8');
        await this.reports.run(() =>
          db()
            .update(reportExport)
            .set({ status: 'ready', objectKey: key, rows, completedAt: new Date() })
            .where(and(eq(reportExport.id, exportId), eq(reportExport.status, 'pending'))),
        );
        this.metrics.inc('report.exports_total', { tenant: tenantId, kind: row.kind, outcome: 'ready' });
        this.metrics.inc('report.export_rows_total', { tenant: tenantId, kind: row.kind }, rows);
        return 'ready';
      } catch (e) {
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          this.metrics.inc('report.exports_total', { tenant: tenantId, kind: row.kind, outcome: 'failed' });
          await this.reports.run(() => db().update(reportExport).set({ status: 'failed', failure: (e as Error).message.slice(0, 200) }).where(eq(reportExport.id, exportId)));
        }
        throw e;
      }
    });
  }
}

@ApiTags('reports')
@Controller('reports/exports')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Roles('theatre_manager', 'chain_admin')
  @DeferTenantTransaction()
  @Post()
  create(@Body() b: CreateExportDto) {
    return this.exports.request({ kind: b.kind, from: new Date(b.from), to: new Date(b.to) });
  }

  @Roles('theatre_manager', 'chain_admin')
  @DeferTenantTransaction()
  @Get(':id')
  get(@Param('id', Uuid) id: string) {
    return this.exports.status(id);
  }
}
