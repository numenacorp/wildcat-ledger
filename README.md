# Ledger

A double-entry accounting server with an HTTP API and no user interface.

Ledger is a modified fork of [Bigcapital](https://github.com/bigcapitalhq/bigcapital).
The web application, browser tests and documentation site have been removed,
and an extension module (`ledger-ext`) is being added for use as an embedded
ledger behind another application. Bigcapital's copyright notices and licence
are unchanged.

## What it does

- Chart of accounts, manual journals, bills, sale invoices, payments, vendors
  and customers.
- Financial statements on the accrual and cash basis.
- Transactions locking, and tracking categories on entry lines.
- One database per organization.

## Running it locally

Requirements: Node.js 18, pnpm 9, Docker.

```bash
pnpm install
pnpm run build:server
pnpm run system:migrate:latest
pnpm run dev:server
```

The server needs MariaDB and Redis. Configuration is read from
`packages/server/.env`, or from `.env` at the repository root; `.env.example`
lists every setting.

## Layout

| Path | Contents |
|---|---|
| `packages/server` | The NestJS server and its command-line tool |
| `shared/bigcapital-utils` | Shared helpers |
| `shared/pdf-templates` | Invoice PDF templates |
| `shared/email-components` | Email templates |

## Tests

```bash
cd packages/server
pnpm run test        # unit tests
pnpm run test:e2e    # API tests, against a running MariaDB and Redis
```

## Licence

[GNU Affero General Public License v3.0](LICENSE), the same as Bigcapital. If
you run a modified version of this server for others to use over a network,
the licence requires you to offer them its source.
