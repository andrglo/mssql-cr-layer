# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A thin promise-based wrapper around [`mssql`](https://github.com/patriksimek/node-mssql) (node-mssql). The entire public surface is `src/index.js` — a single `MssqlCrLayer` constructor. The design goal is API-compatibility with [`pg-cr-layer`](https://github.com/andrglo/pg-cr-layer) so callers can switch between SQL Server and Postgres backends without changing query/transaction code. When changing behavior, keep that parity in mind: the two layers are meant to be drop-in interchangeable.

## Commands

- `npm test` — runs the full Mocha suite (`test/index.js`) against a live SQL Server. Requires a reachable server (see below). Uses `--bail --exit --timeout 15000`.
- Run a single test: `npx mocha --exit --timeout 15000 test/index.js --grep "<pattern>"`
- `npx eslint src test` — lint (eslint flat config in `eslint.config.js`; there is no `lint` npm script). Style is enforced: no semicolons, `arrow-parens: as-needed`.
- `npm run ssh` — opens a fish shell inside the running test container.

## Running tests locally

Tests need a real SQL Server; there is no mock. `docker-compose.yml` provides both an MSSQL 2022 server and a Node dev container (`dms`) with the repo mounted at `/root/mssql-cr-layer`.

- `docker compose up -d` then `npm run ssh` to get into the dev container, where `npm test` will reach the `mssql` service.
- Connection comes from env vars read in `test/index.js`: `MSSQL_USER` (default `sa`), `MSSQL_PASSWORD`, `MSSQL_HOST` (default `localhost`), `MSSQL_PORT` (default `1433`). The compose/CI password is `Juriti01`.
- The suite creates and drops three databases (`tests-mssql-cr-layer-1..3`) with snapshot isolation enabled. It connects to `master` first to create them.

CI (`.circleci/config.yml`) runs the same `npm test` against a sibling MSSQL container on `master`, then publishes to npm only when `package.json` version differs from the published version.

## Architecture notes for `src/index.js`

- **Connection pooling is keyed and cached.** `connect()` caches `ConnectionPool`s in a per-instance `Map` keyed by `server+port+database+user`. A cached connection is reused unless the password changed (then it's closed and reopened). `close()` closes every pooled connection. Connection config is stored in a module-level `WeakMap` (`connectionParams`) so credentials aren't exposed as instance properties.

- **`query` / `execute` are the same function** — `execute` just delegates to `query`. Parameter handling has three paths:
  - No params → plain `mssql.Request().query()`.
  - Array params → `$1, $2, ...` placeholders are rewritten to `@p1, @p2, ...` and bound positionally.
  - Object params → `@key` placeholders bound by name. A value can be a raw scalar or `{value, type, maxLength, decimals, timezone}` for explicit typing.
  - Object/array params go through a `PreparedStatement` (prepare → execute → unprepare, always unprepared even on error).

- **`batch`** runs a raw multi-statement script via `mssql.Request().batch()` with no parameter binding — use it for DDL / scripts, `query` for parameterized statements.

- **Type inference** (`getType`): explicit `param.type` (`integer`/`number`/`date`/`datetime`/`string`) wins; `datetime` with `timezone:true` → `DateTimeOffset` else `DateTime2`. Without a type, values are inferred (Date→DateTime2, number→Decimal sized from the value, boolean→Bit, else NVarChar).

- **The `fold` helper** works around a node-mssql quirk: a `SELECT` with duplicate column names returns an array for that column. `fold` collapses it back to a single value when all elements are equal. Every recordset is mapped through `fold`.

- **Two transaction styles**, both honoring `ISOLATION_LEVEL` (instance default `READ_COMMITTED`, overridable per call):
  - `transaction(fn, options)` — managed: `fn(transaction)` returns a promise; auto commit on success, auto rollback on error.
  - `beginTransaction()` / `commit(t)` / `rollback(t)` — manual. A module-level `WeakMap` tracks whether a transaction already rolled back (via the `'rollback'` event) to avoid double-rollback. Pass the transaction object as `options.transaction` to `query`/`execute`/`batch` to run inside it.

- **Config mapping** (`toMssqlConfig`): maps `host`→`server`, defaults port 1433, `requestTimeout` 6000, `pool.min` 0, `options.encrypt:false`, and translates `pool.idleTimeout`→`pool.idleTimeoutMillis`.

- `dialect` is `'mssql'`, `delimiters` are `'[]'`, and `wrap(identifier)` brackets an identifier — these mirror the pg-cr-layer interface.
