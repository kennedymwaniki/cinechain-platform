# movie-chain-api

The CineChain API — multi-tenant cinema ticketing.
NestJS 12 · Drizzle · PostgreSQL 17 · Redis 7 · BullMQ · Socket.IO · MinIO.

Built step by step from [`../IMPLEMENTATION-PLAN.md`](../IMPLEMENTATION-PLAN.md). **Phase 0 (steps 1–8) is
done**; the next step is **9** (venues and the seat-layout generator). Read [`../CLAUDE.md`](../CLAUDE.md)
before changing anything — the one thing not to get wrong is that staff tokens carry `tenant_id` and
customer tokens never do.

## Run it

```bash
docker compose up -d                 # postgres:17-alpine, redis:7-alpine, chainguard minio (+ bucket init)
pnpm install
pnpm keys:gen                        # Ed25519 keys per audience → ./keys (gitignored)
pnpm db:migrate && pnpm db:seed
pnpm start:dev                       # :3000      Swagger → http://localhost:3000/api/v1/docs
pnpm start:control:dev               # :3001      Swagger → http://localhost:3001/admin/docs
```

| | Port | Note |
|---|---|---|
| API | 3000 | application plane, role `cinechain_app` (not owner, NOBYPASSRLS) |
| Control plane | 3001 | loopback only, role `cinechain_control` (no booking/ticket/payment grants) |
| PostgreSQL | **5434** | native clusters already hold 5432 *and* 5433 |
| Redis | **6380** | a native Redis holds 6379 |
| MinIO | 9000 / 9001 | S3 API / console (`cinechain` / `cinechain-minio-secret`) |

## Layout

```
src/tenancy/       THE security boundary: tenant context, scoped transactions, guards. Only place that imports pg.
src/auth/          staff login, tokens (Ed25519 per audience), refresh rotation, the global AccessGuard
src/identity/      consumers: register / verify / Google. The only code touching platform.consumer
src/control/       control plane: operator auth, onboarding state machine + BullMQ worker
src/common/        error model + filter, Zod DTOs/pipe, idempotency, Swagger
src/db/            SQL migrations (source of truth), RLS generator, TENANT_TABLES, Drizzle schema
tools/             db:migrate, db:reset, db:seed (admin connection; outside src/ on purpose)
test/isolation/    the suite that must never be skipped
```
