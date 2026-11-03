# CineChain

A multi-tenant cinema ticketing SaaS. Cinema chains are tenants; the public buys tickets from them.

## If you are an agent starting work here

**Read [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) first.** It is the build order and the
source of truth for *how* this gets built. The user will say **"do step N"** — find `## Step N`,
do only that step, run its verification command, add a row to the Progress log at the foot of the
file, then stop.

## Layout

| Path | What |
|---|---|
| `IMPLEMENTATION-PLAN.md` | The 27-step build plan. Start here. |
| `movie-chain-api/` | The NestJS 12 codebase. Its own `package.json`, pnpm, the installed Node. |
| `movie-chain-docs/` | PRDs and the masterclass, built to PDF. Its own `package.json`, npm. |

The two projects are independent. Never add a package.json at this root.

## The one idea you must not get wrong

There are **three populations of user**, and only one carries a tenant in its token:

| Population | Tenant comes from | Token |
|---|---|---|
| Platform operator | — (spans all tenants) | no `tenant_id` |
| **Tenant staff** | **the JWT** | has `tenant_id` |
| **Consumer** | **the resource** (`screening.tenant_id`, resolved server-side) | **no `tenant_id`** |
| **Guest** | the resource | **no token at all** |

For staff the tenant is an attribute of *the actor*. For a consumer it is an attribute of *the
transaction* — a customer of one chain must be able to buy from another chain while travelling.
Guest checkout with no account is the **primary** booking path.

Tenant context must come from a source the caller cannot forge. Never accept a caller-supplied
`tenant_id` from a path, header, query or body.

## Non-negotiables

1. Every tenant-scoped table: `tenant_id NOT NULL`, RLS `ENABLE`d **and** `FORCE`d, policy with
   `USING` **and** `WITH CHECK`. Exempt: `tenant`, `platform.*`, `drizzle_migrations` — that list
   is complete, and extending it requires changing the schema-guard test.
2. The app connects as `cinechain_app` — **not** the table owner, **`NOBYPASSRLS`**. An app that
   owns its tables silently voids every policy while all the tests still pass.
3. Only `src/tenancy/` may import `pg` or `drizzle-orm/node-postgres`.
4. Business logic never writes `tenant_id` in a `where` clause, and never branches on tier.
5. Cross-tenant resources return **404, never 403** — a 403 confirms existence.
6. Money is an integer in minor units with an explicit currency. No floats.
7. Background jobs take `tenantId` in the payload. Exactly two jobs are exempt and both are
   marked `@CrossTenantJob`.

## Four corrections to the PRD's sample code

The PRDs predate the build and contain four defects (a fifth, in step 11's SQL, is fixed in the plan). `IMPLEMENTATION-PLAN.md` has the detail.

- `SET LOCAL app.tenant_id = $1` **cannot be parameterised** — use
  `SELECT set_config('app.tenant_id', $1, true)`. The tempting workaround is string interpolation,
  which puts a SQL-injection sink in the most security-critical line in the system.
- The tenancy interceptor must use `lastValueFrom(next.handle())`, or it commits and releases the
  connection *before* the handler runs.
- Redis keys need **both** tenant and screening inside one hash tag:
  `lock:{t:<tenant>:scr:<screening>}:seat:<seat>`.
- A `SECURITY DEFINER` function owned by the table owner **returns nothing** under `FORCE` RLS. The
  sanctioned cross-tenant read doors are owned by `cinechain_resolver` (`NOLOGIN BYPASSRLS`,
  column-level grants only), called only through `src/tenancy/doors.ts`, and their full list is an
  allowlist (`SANCTIONED_DOORS`) checked by the schema-guard test.

Two more rules learned while building: every FK between tenant tables is **composite**
`(tenant_id, x_id)` (FK checks bypass RLS), and in a raw Drizzle `sql` template a correlated
subquery must name the outer table explicitly (`"screening"."id"`): `${table.col}` renders
unqualified and can silently bind to the inner table.

From the booking core (steps 13–21):

- **The doors are six** (`SANCTIONED_DOORS`). A new cross-tenant lookup is a new door, reviewed;
  the schema guard pins each door's return columns.
- **Anything that calls a provider runs outside a transaction** (`@DeferTenantTransaction`, short
  explicit scopes). Record intent first (`booking=pending`, a `pending` refund), then call.
- **Concurrent inserts checked by an exclusion constraint deadlock** (`40P01`): take
  `pg_advisory_xact_lock` on the parent first (see `ScreeningRepository.lockScreens`).
- **A process must be able to stop while Redis is down:** register producer queues with
  `registerProducerQueue` (`enableOfflineQueue: false`); force-close workers on shutdown.
- **Bearer secrets never go in a path** (ticket codes travel in the body): paths reach access logs.
- Every `@Processor` takes `tenantId` in its payload; `test/isolation/worker-context.spec.ts`
  runs each one with only its payload. A new processor needs a probe there.

From operations (steps 22–24):

- **Reports run on their own pool** (`ReportingDb`) and their routes are `@DeferTenantTransaction`.
  `TenantDb` refuses a scope nested inside another pool's scope.
- **Never log a tenant at a call site.** The logger's mixin adds `tenant_id`; the tenancy layer
  calls `announceTenant()` the moment the server learns it. Never log contact details or links
  carrying secrets.
- **Metrics take the real tenant id; `TenantLabels` decides the label** (top 50, the rest `other`).
  Name counters `*_total` (prom-client does not add it).
- **Metering never reads tenant tables.** The aggregator runs in the control plane, whose role has
  no grant on booking/ticket/payment. Exactly two `@CrossTenantJob`s exist; that is final.
- **Two Docker engines exist on this machine** (`docker context ls`: `default` and Docker
  Desktop). The dev data lives on `default`. If Postgres looks empty, check the context first.

The PRDs also still describe Keycloak and siloed databases. We use in-app Passport, and everything
is pooled in one database for now.

## Commands

```bash
# API — first run
cd movie-chain-api && docker compose up -d && pnpm install
pnpm keys:gen && pnpm db:migrate && pnpm db:seed   # keys:gen only ADDS missing keys (e.g. booking-v1)
pnpm start:dev                 # application plane :3000   (Swagger: /api/v1/docs)
pnpm start:control:dev         # control plane 127.0.0.1:3001 (Swagger: /admin/docs)

pnpm lint && pnpm typecheck && pnpm build   # build also lints (money-field rule)
pnpm test                # unit (Testcontainers Postgres)
pnpm test:isolation      # cross-tenant reads return nothing; rolbypassrls = false; schema guard
pnpm test:e2e            # onboarding smoke (Postgres + Redis containers)
pnpm test:concurrency    # races on real Postgres + Redis: exactly one winner (CI: --repeats 20)

# Docs
cd movie-chain-docs && npm run masterclass   # builds + opens in Chrome
npm run build                                 # all PDFs (the plan PDF is rendered from IMPLEMENTATION-PLAN.md)
```

Dev logins (password `cinechain-dev-password`): staff `chris@nyati.test` (tenant_slug `nyati`),
operator `purity@cinechain.test`. Node is the installed v25; NestJS 12.

Observability (optional profile): `docker compose --profile observability up -d` adds
Prometheus (127.0.0.1:9090, scrapes both planes, loads `deploy/alerts/`), Loki (127.0.0.1:3100),
Alloy (ships `logs/*.log`, from `LOG_FILE`/`LOG_FILE_CONTROL`) and Grafana on **127.0.0.1:3030**
(`admin` / `cinechain-grafana`, dashboard "CineChain — overview"). Prometheus and Grafana use host
networking (native engine): the metrics endpoints answer loopback only.

Postgres is on **5434** and Redis on **6380**. Native Postgres clusters already hold 5432 *and* 5433,
and a native Redis holds 6379. MinIO (S3-compatible, posters and exports) is on **9000**, with its
console on **9001**; object keys are always prefixed `t/<tenant_id>/`.
