---
"@chronicle/core": minor
"@chronicle/postgres": minor
"@chronicle/testing": minor
"chronicle": minor
---

Initial release of chronicle — enterprise-grade, TypeScript-first database migrations for Node.js.

### @chronicle/core

- **Migration engine** with checksum drift detection, batch tracking, and advisory lock support
- **Schema DSL** — fluent builder for `createTable`, `alterTable`, `dropTable`, `createEnum`, `dropEnum`, `renameTable`, `truncate`, and `raw` SQL
- **AlterTable operations** — `addColumn`, `dropColumn`, `renameColumn`, `changeType`, `setNullable`/`setNotNullable`, `setDefault`/`dropDefault`, `addForeignKey`/`dropForeignKey`, `addIndex`/`dropIndex`, `renameIndex`, `addPrimaryKey`/`dropPrimaryKey`, `addCheck`/`dropCheck`, `addUniqueConstraint`/`dropUniqueConstraint`
- **Baseline / fake-run** — `migrator.baseline()` and `up/down({ fake: true })` for adopting existing databases without re-running SQL
- **Dry-run mode** — preview all SQL statements before any mutation
- **Multi-directory support** — `migrations.directory` accepts `string | string[]`
- **Migration file format validation** — enforces `YYYYMMDDHHMMSS_name` convention at load time
- **Checksum versioning** — `checksumAlgo` stored alongside every migration record
- **Statement and migration timeouts** — `execution.statementTimeoutMs` and `execution.migrationTimeoutMs`
- **Structured logger** — `createLogger(events, { level, writer })` with `silent | error | warn | info | debug` levels
- **Production rollback guard** — `preventProductionRollback` policy blocks `down` in production
- **Configurable policies** — `requireDown`, `preventProductionRollback`
- **Event bus** — `migration:start`, `migration:success`, `migration:failure`, `sql:statement` events
- **Config validation** — detailed field-level errors on invalid `chronicle.config.ts`

### @chronicle/postgres

- **PostgreSQL adapter** using `pg` (node-postgres) connection pool
- **Advisory lock** via `pg_try_advisory_lock` — concurrent-deployment safe, namespace-scoped
- **Transaction support** with `SET LOCAL statement_timeout` inside transactions
- **Connection retry** — backoff retry on transient PostgreSQL errors (`08*`, `57P01-03`)
- **Repository** with `chronicle_migrations` and `chronicle_migration_log` tables, auto-indexed
- **SQL compiler** for all schema DSL commands including PostgreSQL-specific features (concurrent indexes, `timestamptz`, native enums, `jsonb`)

### @chronicle/testing

- **`InMemoryAdapter`** — zero-dependency adapter for unit testing migrations without a real database
- **`createTestMigrator()`** — one-liner test setup with sensible defaults
- **`createMigrationFixtures()`** — create temporary migration files for integration-style tests
- **`InMemoryRepository`** — full `MigrationRepository` implementation backed by a `Map`
- **`InMemorySchemaCompiler`** — returns readable comment SQL for schema assertions

### chronicle (CLI)

- `chronicle init` — scaffold `chronicle.config.ts` and migrations directory
- `chronicle make <name>` — generate timestamped migration file
- `chronicle up` — run pending migrations (`--step`, `--to`, `--dry-run`, `--fake`)
- `chronicle down` — roll back (`--step`, `--to`, `--dry-run`, `--fake`, `--force`)
- `chronicle baseline` — mark pending migrations as applied without running SQL (`--to`)
- `chronicle status` — show all migration statuses
- `chronicle plan` — preview pending and rollback candidates
- `chronicle verify` — exit 1 on drift (CI/CD integration)
- `--format json` — machine-readable JSON output on all commands
