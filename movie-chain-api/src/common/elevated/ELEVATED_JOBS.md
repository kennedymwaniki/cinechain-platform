# Elevated (cross-tenant) jobs

Convention 10: every background job takes `tenantId` in its payload and calls
`runWithTenant` as its first action. **Exactly two** jobs are exempt. Each is
marked `@CrossTenantJob(reason)` in code and listed here.
`test/isolation/elevated-jobs.spec.ts` fails if the code and this list disagree.

| Job | Since | Role | Reaches | Why it cannot be tenant-scoped |
|---|---|---|---|---|
| `SweeperProcessor` (`src/inventory/sweeper.processor.ts`) | step 15 | `cinechain_sweeper` (BYPASSRLS) | `SELECT` on five `seat_lock` columns, `DELETE` on `seat_lock`. Nothing else. | Expired holds exist in every tenant at once; one pass per tick across all of them is the point. A per-tenant fan-out would need a cross-tenant read to find the tenants anyway. |
| `MeteringAggregatorProcessor` (`src/metering/aggregator.processor.ts`) | step 24 | `cinechain_control` (no BYPASSRLS; **no grant** on `booking`, `ticket`, `payment`) | Redis `usage:{t:*}` counters, object-storage sizes under `t/<tenant>/`, the `tenant` registry; writes `platform.metering_usage` only. | Folds every tenant's counters in one pass. It reads no tenant table at all: it counts what the application plane already counted, so it cannot see a booking even by mistake. |

## Not elevated: registry fan-out

`@RegistryFanout` marks a tick that reads only the `tenant` registry and
enqueues one ordinary tenant-scoped job per chain. It touches no tenant data.

| Job | Since | Fans out to |
|---|---|---|
| `ReconciliationProcessor` `fanout` (`src/booking/reconciliation.processor.ts`) | step 19 | `reconcile` `{ tenantId }`, per active chain |

Adding a third requires changing the spec. That is deliberate: it is a review, not a convention.
