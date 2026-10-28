# CineChain

A multi-tenant ticketing platform for cinema chains. Each chain (Nyati Cinemas, Prestige Screens, …)
runs its theatres, screens, films, schedules and pricing on CineChain. The public browses showtimes,
picks seats on a live seat map and buys tickets, and can do so without creating an account.

## What it does

- **For cinema chains (tenants):** manage theatres, screens and seat layouts, curate films, schedule
  screenings, set prices per seat class, sell at the box office, scan tickets at the door, and see
  occupancy and revenue across every theatre in the chain.
- **For moviegoers:** browse films by town and date, open a seat map that updates live, hold seats
  for a few minutes while paying by card or M-Pesa, and receive tickets by SMS and e-mail. Guest
  checkout is the primary path; an optional account works across every chain on the platform.
- **For the platform operator:** onboard a new chain in under a minute, suspend or re-tier it,
  meter usage, bill it, and offboard it with provable deletion. Operators cannot see booking or
  customer data.

## Architecture

```
                   ┌─────────────────────────────────────────┐
  guests           │  API  :3000            application plane │
  customers  ────▶ │  NestJS · REST · Socket.IO               │
  staff            │  DB role: cinechain_app (no RLS bypass)  │
                   └───────────────────┬─────────────────────┘
                                       │
  operators  ────▶ ┌───────────────────┴─────────────────────┐
                   │  Control plane  :3001   (separate process)│
                   │  onboarding · tiers · metering · billing │
                   │  DB role: cinechain_control              │
                   │  no access to bookings or customers      │
                   └───────────────────┬─────────────────────┘
                                       │
          ┌────────────────────────────┴───────────────────────────┐
          │  PostgreSQL 17              Redis 7             MinIO   │
          │  one database, row-level    seat locks, cache,  posters,│
          │  security on every tenant   BullMQ queues,      exports │
          │  table                      Socket.IO adapter           │
          └─────────────────────────────────────────────────────────┘
```

**Pooled multi-tenancy.** All chains share one database and one set of tables. Every tenant-owned
row carries a `tenant_id`, and PostgreSQL row-level security, enabled and forced on every such
table, decides what each request can see. The application connects as a role that does not own the
tables and cannot bypass the policies, so a query that forgets to filter by tenant returns nothing
rather than another chain's data. A test suite fails the build if any table lacks its policy.

**Three kinds of user, two kinds of tenancy.**

| User | Where their tenant comes from |
|---|---|
| Chain staff | Their login token, which names exactly one chain |
| Customers and guests | The thing they are buying: a screening belongs to a chain, looked up server-side |
| Platform operators | None: they work across chains, on a separate process with no access to sales data |

A customer's token deliberately carries no chain, so one account can buy from any chain. The
server never accepts a tenant id supplied by the caller.

**Seat holds that cannot double-sell.** Selecting seats takes an all-or-nothing lock in Redis
(one atomic script), backed by a durable row in PostgreSQL whose primary key is
`(screening, seat)`. Redis makes holds fast; PostgreSQL makes them correct. If Redis is down,
bookings keep working on the database alone. Holds expire on their own, and payment is captured
outside any database transaction so a slow mobile-money confirmation never ties up a connection.

**Two planes.** The application plane serves customers and staff. The control plane is a separate
process with its own database role and handles onboarding (a resumable state machine that records
every resource it creates so a failure can be rolled back), tiering, metering and billing. "Operators
cannot read bookings" is enforced by database grants, not by convention.

## Stack

NestJS 12 · TypeScript · Drizzle ORM · PostgreSQL 17 · Redis 7 · BullMQ · Socket.IO · MinIO (S3) ·
Passport (e-mail/password and Google sign-in) · Ed25519-signed JWTs · Zod · Swagger/OpenAPI ·
Vitest with Testcontainers

## Repository layout

| Path | Contents |
|---|---|
| [`movie-chain-api/`](movie-chain-api/) | The NestJS application: API and control plane. See its README to run it. |
| [`movie-chain-docs/`](movie-chain-docs/) | Product requirements and a guide to multi-tenant architecture, built to PDF. |

## Quick start

```bash
cd movie-chain-api
docker compose up -d            # PostgreSQL, Redis, MinIO
pnpm install
pnpm keys:gen && pnpm db:migrate && pnpm db:seed
pnpm start:dev                  # API: http://localhost:3000/api/v1/docs
```
