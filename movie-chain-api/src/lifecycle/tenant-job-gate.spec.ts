import { DelayedError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import type { TenantRegistry } from '../tenancy/tenant-registry.service';
import { PAUSED_RETRY_MS, TenantJobGate } from './tenant-job-gate';

const T = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const gateFor = (status: string | null) =>
  new TenantJobGate({ byId: async () => (status ? { id: T, status } : null) } as unknown as TenantRegistry);
function fakeJob() {
  const moved: number[] = [];
  return { moved, job: { moveToDelayed: async (at: number) => void moved.push(at) } as never };
}

describe('tenant job gate (step 27: pause by tenant)', () => {
  it('an active tenant runs', async () => {
    expect(await gateFor('active').check(fakeJob().job, 't', T)).toBe('run');
  });

  it('a suspended tenant is put back, delayed, and resumes on reactivation', async () => {
    const f = fakeJob();
    const before = Date.now();
    await expect(gateFor('suspended').check(f.job, 't', T)).rejects.toBeInstanceOf(DelayedError);
    expect(f.moved[0]).toBeGreaterThanOrEqual(before + PAUSED_RETRY_MS);
    expect(await gateFor('active').check(fakeJob().job, 't', T)).toBe('run');
  });

  it('an offboarding, deleted or unknown tenant is dropped', async () => {
    for (const s of ['offboarding', 'deleted', null]) expect(await gateFor(s).check(fakeJob().job, 't', T)).toBe('drop');
  });
});
