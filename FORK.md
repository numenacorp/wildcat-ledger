# Changes from Bigcapital

This repository is a modified fork of
[Bigcapital](https://github.com/bigcapitalhq/bigcapital), taken from its
`develop` branch at commit `600124308` (2026-11-11). This file lists what has
been changed, so that an upstream fix to the same code can still be brought
over, and so that anyone comparing the two knows where to look.

## Removed

| What | Path |
|---|---|
| The web application | `packages/webapp` |
| Browser tests and their configuration | `e2e/`, `playwright.config.ts`, `playwright.screenshots.config.ts` |
| Screenshots | `screenshots/` |
| Documentation site sources | `docs/` |
| Proxy and object-store configuration for the bundled deployment | `docker/envoy`, `docker/garage` |
| Deployment and editor helpers | `setup.sh`, `vercel.json`, `launch.json`, `repro-tmp.mjs`, `.gitpod.yml`, `.cursor/`, `.specify/`, `.vscode/`, `.codegraph/`, `.all-contributorsrc` |
| Git hooks and commit linting | `.husky/`, `commitlint.config.js` |
| Workflows for the removed parts and for publishing Bigcapital's images | `.github/workflows/e2e.yml`, `screenshots.yml`, `build-deploy-container.yml`, `build-deploy-develop-container.yaml`, `.github/FUNDING.yml` |

## Changed in Bigcapital's own files

| # | File | Change | Why |
|---|---|---|---|
| 1 | `packages/server/src/modules/Tenancy/TenancyDB/TenancyDB.module.ts` | Organization migrations are loaded as `.ts` when the server runs from TypeScript sources, `.js` otherwise | An organization could not be built inside the test runner, which has no compiled migrations |
| 2 | `packages/server/src/modules/Items/dtos/Item.dto.ts` | `unit` is optional on an item | Upstream made it required by omission on 2026-10-28, which rejects every item created without one |
| 3 | `packages/server/src/modules/Analytics/services/LedgerClickHouseSink.service.ts` | No analytics job is queued when ClickHouse is disabled | Every ledger write queued a job that failed and retried five times against a store that is not there |
| 4 | `packages/server/src/common/config/tenant-database.ts`, `packages/server/src/modules/Tenancy/TenancyDB/TenancyDB.module.ts` | The size of an organization's connection pool is read from `TENANT_DB_POOL_MAX` (default 7, as before) | The pool size was fixed in code |
| 5 | `packages/server/src/common/config/*-database.ts`, the six places a connection is opened, `TenantDBManager.ts` | Connections and new organization databases use `utf8mb4` (or the charset named by `DB_CHARSET`) | The charset was fixed at 3-byte `utf8` in code, and `DB_CHARSET` was never read. Four-byte characters could not be stored. |
| 6 | `packages/server/src/common/pipes/ClassValidation.pipe.ts`, new `common/decorators/StrictDto.ts` | A request DTO marked `@StrictDto()` refuses unknown properties | Unknown properties are otherwise dropped silently |
| 7 | `packages/server/src/common/config/queue.ts`, `packages/server/src/modules/App/App.module.ts` | The key prefix of the job queues is read from `QUEUE_PREFIX` (default `bull`, as before) | Lets two processes on one Redis keep their queues apart |
| 8 | `packages/server/src/modules/CLI/commands/TenantsMigrateLatest.command.ts` | `tenants:migrate:latest` skips an organization whose database does not exist, and reports other failures after the remaining organizations have been migrated | One missing database stopped the command, and with it every deploy; the stop also cut off migrations running beside it |
| 9 | `packages/server/src/common/interceptors/serialize.interceptor.ts`, new `common/decorators/OpaqueKeys.ts` | A controller marked `@OpaqueKeys('metadata')` has those properties passed through without their keys being rewritten between snake_case and camelCase | The rewrite reaches every nested key, so a caller's free-form data came back with different keys |
| 10 | `packages/server/src/modules/ManualJournals/commands/EditManualJournal.service.ts` | `editJournalEntries` takes an optional transaction to join, as the create and delete services already do | An edit could not be made part of a larger atomic operation |
| 11 | `packages/server/src/modules/ManualJournals/commands/CommandManualJournalValidators.service.ts` | A manual journal whose debits and credits are both zero is accepted | A caller records a zero entry to mark that something happened; it was refused |
| 12 | `packages/server/src/main.ts`, new `common/request-body.ts` | The largest JSON request body is set from `REQUEST_BODY_LIMIT`, 20 MB by default | The framework's default of 100 KB refused a request creating a few hundred records |
| 13 | `packages/server/src/modules/Ledger/LedgerEntriesStorage.service.ts` | The tracking assignments of a ledger row are inserted one at a time | A line with two tracking categories got ledger rows carrying neither: the single insert of both was refused on MySQL and MariaDB, and the refusal was lost in the save queue. Worth sending upstream. |
| 14 | `packages/server/src/common/config/` (new `database-ssl.ts`), and the five places a database connection is built | Every database connection uses TLS when `DB_SSL=true` | A managed database accepts only encrypted connections, and there was no setting for it |
| 15 | `packages/server/src/modules/Ledger/LedgerEntriesStorage.service.ts`, `LedgerContactStorage.service.ts`, `LedgetAccountStorage.service.ts` | A ledger row or a balance that cannot be saved fails the write | Rows and balance updates were pushed onto a queue and the queue only drained, so a failure went unseen. A row that failed to save left a document with rows missing from the books; a deadlock on a contact's balance was swallowed and the write carried on after the database had rolled its transaction back, leaving balances changed for documents that no longer existed. Worth sending upstream. |

## Added

| What | Path |
|---|---|
| The ledger extension: workspaces created with a chart of accounts, external ids a repeated create replaces by, metadata, exact timestamps, stable line ids | `packages/server/src/modules/LedgerExt/`, migrations named `*_ledger_ext_*` |
| Bills, vendors and bill payments kept by the extension, posting through the ledger: a bill may be voided and still edited or paid, and a payment is recognised on the cash basis line by line, to the cent | `packages/server/src/modules/LedgerExt/Trade/` |
| Tracking categories and options as records, and links between a line and an option made and removed on their own, each with an id | `packages/server/src/modules/LedgerExt/Tracking/` |
| Fixed assets with value updates, loans, and opening balances imported once, each posting through the ledger | `packages/server/src/modules/LedgerExt/Books/` |
| Bank routes that answer empty lists until there is a bank feed | `packages/server/src/modules/LedgerExt/Bank/` |
| Tests that create an organization per spec file | `packages/server/test/ledger/` |
| One Compose file for the local stack, and a script that brings it up | `docker-compose.yml`, `docker-compose.local.yml` (the converter on the host's network, for a server run on the host), `scripts/local-up.sh` |
| A check that keeps this fork's own files to generic accounting | `scripts/check-terms.mjs` |
| A workflow that runs the above | `.github/workflows/ledger.yml` |
