# AGENTS.md

## Repo overview

Ledger is a double-entry accounting server with an HTTP API and no user
interface. It is a modified fork of Bigcapital. pnpm + Lerna monorepo.

| Package | Path | Role |
|---|---|---|
| `@bigcapital/server` | `packages/server` | NestJS API + CLI. A system DB plus one DB per organization (MariaDB). Knex migrations, Objection.js ORM. |
| `@bigcapital/utils` | `shared/bigcapital-utils` | Shared utilities. tsup (CJS + ESM). |
| `@bigcapital/pdf-templates` | `shared/pdf-templates` | PDF invoice templates. Webpack. |
| `@bigcapital/email-components` | `shared/email-components` | Email templates (react-email). Vite. |

## Dev setup

1. `docker compose up -d` starts MariaDB (33306), Redis (36379), Gotenberg (39100) and an S3 stand-in (39000).
2. Create `packages/server/.env` (see `.env.example`), pointing at those ports.
3. `pnpm install`
4. `pnpm run build:server` (**must run before migrations**; the CLI runs from built output)
5. `pnpm run system:migrate:latest`
6. `pnpm run dev:server`

## Common commands

Run from repo root unless noted.

| What | Command |
|---|---|
| Build server + shared deps | `pnpm run build:server` |
| Typecheck | `pnpm run typecheck` |
| Lint | `pnpm run lint` (fix) / `pnpm run lint:check` |
| Format | `pnpm run format` (fix) / `pnpm run format:check` |
| System DB migrations | `pnpm run system:migrate:latest` |
| Organization DB migrations | `pnpm run tenants:migrate:latest` |
| Server unit tests | `cd packages/server && pnpm run test` |
| Server API tests | `cd packages/server && pnpm run test:e2e` |
| Ledger tests only | `cd packages/server && pnpm exec jest --config ./test/jest-e2e.json --forceExit test/ledger` |

## Key facts

- **Node 18** (`.nvmrc`).
- **Wire format is snake_case.** A global `SerializeInterceptor`
  (`packages/server/src/common/interceptors/serialize.interceptor.ts`) converts
  request bodies and queries from snake_case to camelCase for the DTOs, and
  responses back to snake_case. Define DTOs in camelCase.
- **Database columns are snake_case**; Objection models expose camelCase.
- **Two migration systems:** `packages/server/src/database/system/` and
  `packages/server/src/database/tenant/`, with separate CLI commands.
- **Env file:** `packages/server/.env` wins over a root `.env`.
- **Server path alias:** `@/*` maps to `packages/server/src/*`.
- **Multi-tenancy:** the organization is chosen per request by the
  `organization-id` header and held in `nestjs-cls`. Background jobs set it
  themselves.
- **Transactions:** services take an optional Knex transaction and run inside
  `UnitOfWork.withTransaction`. Ledger rows are written by event subscribers
  that receive the same transaction.
- **Background jobs:** BullMQ on Redis. Every process connected to the same
  Redis shares the queues, so two test runs against one Redis can take each
  other's jobs.

## Tests

- `packages/server/test/*.e2e-spec.ts` are upstream's API tests. They share one
  seeded organization (`kk@kk.com`) and assert on deltas.
- `packages/server/test/ledger/` are this fork's tests. Each spec file creates
  an organization of its own through `harness.ts` and drops it at the end, so
  figures can be asserted absolutely.

## What does not belong here

This repository is public. Keep it to generic accounting. No customer data, no
credentials, no industry-specific logic, and no recordings of any other
vendor's API.
