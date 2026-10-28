import { SetMetadata } from '@nestjs/common';

export const CROSS_TENANT_JOB = 'cinechain:cross-tenant-job';

/**
 * Marks one of the TWO jobs allowed to run without a tenant scope
 * (convention 10). Every other @Processor takes tenantId in its payload and
 * calls runWithTenant first. See ELEVATED_JOBS.md; the list is pinned by
 * test/isolation/elevated-jobs.spec.ts.
 */
export const CrossTenantJob = (reason: string) => SetMetadata(CROSS_TENANT_JOB, reason);

export const REGISTRY_FANOUT = 'cinechain:registry-fanout';

/**
 * NOT an elevated job. Marks a processor whose scheduled tick reads only the
 * `tenant` registry (no tenant data, no RLS table) to enqueue one ordinary
 * tenant-scoped job per chain; its real work runs in those jobs, each in its
 * own tenant scope. The worker-context spec (step 21) checks both halves.
 */
export const RegistryFanout = (reason: string) => SetMetadata(REGISTRY_FANOUT, reason);
