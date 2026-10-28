import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../../common/errors/api-error';
import { onboardingRun, onboardingStep, type RecordedResource } from '../../db/schema/control';
import { tenant } from '../../db/schema/tenant';
import { ControlDb } from '../../tenancy/control-db.provider';
import { db, runWithTenant } from '../../tenancy/tenant-context';
import { toSystemContext } from '../../tenancy/system-context';
import { assertTransition, type RunStatus } from './onboarding.state-machine';
import { deleteResource, ONBOARDING_STEPS, type OnboardingRequest, type OnboardingStep } from './onboarding.steps';
import { StaffInviteMailer } from '../../staff/staff-invite.mailer';

export const ONBOARDING_QUEUE = 'control.onboarding';
export interface OnboardingJob {
  runId: string;
  tenantId: string;
}

@Injectable()
export class OnboardingService implements OnApplicationBootstrap {
  private readonly log = new Logger(OnboardingService.name);
  /** Overridable in tests (e.g. to inject a failing step). */
  steps: OnboardingStep[] = ONBOARDING_STEPS;

  constructor(
    private readonly control: ControlDb,
    private readonly mailer: StaffInviteMailer,
    @InjectQueue(ONBOARDING_QUEUE) private readonly queue: Queue<OnboardingJob>,
  ) {}

  /** Resumes any run interrupted by a crash or restart. Enqueueing is idempotent (jobId = runId). */
  async onApplicationBootstrap(): Promise<void> {
    const live = await this.control.platformTx((tx) =>
      tx
        .select({ id: onboardingRun.id, tenantId: onboardingRun.tenantId })
        .from(onboardingRun)
        .where(inArray(onboardingRun.status, ['pending', 'provisioning'])),
    );
    for (const r of live) await this.enqueue(r.id, r.tenantId);
    if (live.length) this.log.log(`resuming ${live.length} onboarding run(s)`);
  }

  async request(req: OnboardingRequest, operatorId: string) {
    const tenantId = randomUUID();
    const run = await this.control.platformTx(async (tx) => {
      const [taken] = await tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.slug, req.slug));
      if (taken) throw conflict('slug_taken', `The slug "${req.slug}" is already in use`);
      try {
        const [r] = await tx
          .insert(onboardingRun)
          .values({ tenantId, slug: req.slug, request: { ...req }, requestedBy: operatorId })
          .returning();
        return r!;
      } catch (e) {
        if ((e as { cause?: { code?: string } }).cause?.code === '23505')
          throw conflict('slug_taken', `An onboarding for "${req.slug}" is already in progress`);
        throw e;
      }
    });
    await this.enqueue(run.id, tenantId);
    return { run_id: run.id, tenant_id: tenantId, status: run.status };
  }

  async status(tenantId: string) {
    return this.control.platformTx(async (tx) => {
      const [run] = await tx
        .select()
        .from(onboardingRun)
        .where(eq(onboardingRun.tenantId, tenantId))
        .orderBy(desc(onboardingRun.createdAt))
        .limit(1);
      if (!run) throw notFound();
      const steps = await tx
        .select({ name: onboardingStep.name, status: onboardingStep.status, finished_at: onboardingStep.finishedAt })
        .from(onboardingStep)
        .where(eq(onboardingStep.runId, run.id))
        .orderBy(asc(onboardingStep.seq));
      return {
        run_id: run.id,
        tenant_id: run.tenantId,
        slug: run.slug,
        status: run.status,
        error: run.error,
        created_at: run.createdAt,
        finished_at: run.finishedAt,
        steps,
      };
    });
  }

  /** After a rollback: start a fresh run from the same request. After FAILED: finish compensation first. */
  async retry(runId: string, operatorId: string) {
    const run = await this.loadRun(runId);
    if (run.status === 'failed') await this.compensate(run.id, run.tenantId, run.error ?? 'retry');
    else if (run.status !== 'rolled_back') throw conflict('not_retryable', `Run is ${run.status}`);
    return this.request(run.request as unknown as OnboardingRequest, operatorId);
  }

  /**
   * Undo a completed onboarding (throwaway tenants: the smoke test). Deletes
   * exactly the recorded resources; if the tenant has acquired ANY other data
   * the foreign keys refuse, and the tenant is left intact. Real offboarding
   * (export, then verified deletion) is step 27.
   */
  async undo(tenantId: string) {
    const [run] = await this.control.platformTx((tx) =>
      tx
        .select()
        .from(onboardingRun)
        .where(and(eq(onboardingRun.tenantId, tenantId), eq(onboardingRun.status, 'active'))),
    );
    if (!run) throw notFound();
    try {
      await this.compensate(run.id, tenantId, 'undone by operator');
    } catch (e) {
      if (String((e as { cause?: { code?: string } }).cause?.code) === '23503')
        throw conflict('tenant_has_data', 'This tenant has data beyond onboarding; use offboarding');
      throw e;
    }
    return { tenant_id: tenantId, status: 'rolled_back' as RunStatus };
  }

  // ------------------------------------------------------------------ worker

  /** Executes the run. Called by the processor; safe to call again after a crash. */
  async execute(job: OnboardingJob, isFinalAttempt: boolean): Promise<void> {
    const run = await this.loadRun(job.runId);
    if (run.status === 'active' || run.status === 'rolled_back') return;
    if (run.status === 'failed') return; // waits for an operator retry
    await this.setStatus(run.id, run.status, 'provisioning');

    const done = new Set(
      (
        await this.control.platformTx((tx) =>
          tx
            .select({ name: onboardingStep.name })
            .from(onboardingStep)
            .where(and(eq(onboardingStep.runId, run.id), eq(onboardingStep.status, 'done'))),
        )
      ).map((s) => s.name),
    );
    const request = run.request as unknown as OnboardingRequest;

    for (const [seq, step] of this.steps.entries()) {
      if (done.has(step.name)) continue; // resume: never redo a committed step
      const after: (() => Promise<void>)[] = [];
      try {
        await this.inTenant(job.tenantId, async () => {
          const resources = await step.run({
            runId: run.id,
            tenantId: job.tenantId,
            request,
            afterCommit: (fn) => after.push(fn),
            send: { activation: (e, s, t) => this.mailer.sendActivation(e, s, t) },
          });
          await this.recordStep(run.id, seq, step.name, resources);
        });
      } catch (e) {
        const message = `${step.name}: ${(e as Error).message}`;
        if (!isFinalAttempt) throw e; // BullMQ retries with backoff; done steps are skipped
        this.log.error(`onboarding ${run.id} failed at ${message}; compensating`);
        await this.compensate(run.id, job.tenantId, message);
        return;
      }
      for (const fn of after) await fn();
    }
    await this.setStatus(run.id, 'provisioning', 'active');
    this.log.log(`tenant ${request.slug} (${job.tenantId}) is ACTIVE`);
  }

  /** Deletes every recorded resource, newest first, then marks the run rolled back. */
  async compensate(runId: string, tenantId: string, reason: string): Promise<void> {
    const run = await this.loadRun(runId);
    try {
      const steps = await this.control.platformTx((tx) =>
        tx
          .select()
          .from(onboardingStep)
          .where(and(eq(onboardingStep.runId, runId), eq(onboardingStep.status, 'done')))
          .orderBy(desc(onboardingStep.seq)),
      );
      for (const s of steps)
        await this.inTenant(tenantId, async () => {
          for (const r of [...(s.resources as RecordedResource[])].reverse()) await deleteResource(r);
          // recorded in the same transaction as the deletes
          await db()
            .update(onboardingStep)
            .set({ status: 'compensated', finishedAt: new Date() })
            .where(and(eq(onboardingStep.runId, runId), eq(onboardingStep.name, s.name)));
        });
      await this.setStatus(runId, run.status, 'rolled_back', reason);
    } catch (e) {
      if (run.status !== 'failed') await this.setStatus(runId, run.status, 'failed', `${reason}; compensation: ${(e as Error).message}`);
      throw e;
    }
  }

  // ----------------------------------------------------------------- helpers

  private enqueue(runId: string, tenantId: string) {
    return this.queue.add('onboard', { runId, tenantId }, { jobId: runId, removeOnComplete: 1000, removeOnFail: 1000 });
  }

  private async loadRun(runId: string) {
    const [run] = await this.control.platformTx((tx) => tx.select().from(onboardingRun).where(eq(onboardingRun.id, runId)));
    if (!run) throw notFound();
    return run;
  }

  private async setStatus(runId: string, from: RunStatus, to: RunStatus, error: string | null = null) {
    assertTransition(from, to);
    const terminal = to === 'active' || to === 'rolled_back';
    await this.control.platformTx((tx) =>
      tx
        .update(onboardingRun)
        .set({ status: to, error, updatedAt: new Date(), ...(terminal ? { finishedAt: new Date() } : {}) })
        .where(eq(onboardingRun.id, runId)),
    );
  }

  private async recordStep(runId: string, seq: number, name: string, resources: RecordedResource[]) {
    await db()
      .insert(onboardingStep)
      .values({ runId, seq, name, status: 'done', resources, finishedAt: new Date() })
      .onConflictDoUpdate({
        target: [onboardingStep.runId, onboardingStep.name],
        set: { status: 'done', resources, finishedAt: new Date() },
      });
  }

  private inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason: 'onboarding' }), () =>
      this.control.withTenantScope(fn),
    );
  }
}
