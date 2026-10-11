# chronicle

Enterprise-grade, TypeScript-first database migrations for Node.js.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Why chronicle?

chronicle fills the gaps other Node.js migration tools leave open:

| Feature | chronicle | Knex | Umzug | db-migrate |
|---------|:---------:|:----:|:-----:|:----------:|
| Checksum drift detection | ✅ | ❌ | ❌ | ❌ |
| Advisory lock (concurrent deploy safe) | ✅ | ❌ | ❌ | ❌ |
| Dry-run (preview SQL before apply) | ✅ | ❌ | ❌ | ❌ |
| Production rollback guard | ✅ | ❌ | ❌ | ❌ |
| Audit log | ✅ | ❌ | ❌ | ❌ |
| Statement/migration timeout | ✅ | ❌ | ❌ | ❌ |
| Test utilities (`@chronicle/testing`) | ✅ | ❌ | ❌ | ❌ |

---

## Packages

| Package | Description |
|---------|-------------|
| [`@chronicle/core`](packages/core) | Migration engine, planner, schema DSL, loader, event bus |
| [`@chronicle/postgres`](packages/postgres) | PostgreSQL adapter, SQL compiler, advisory lock |
| [`@chronicle/testing`](packages/testing) | In-memory adapter and test utilities |
| [`chronicle`](packages/cli) | `chronicle` CLI |

---

## Quick Start

```bash
npm install chronicle @chronicle/core @chronicle/postgres
```

```bash
# 1. Create config + migrations directory
chronicle init

# 2. Generate a new migration file
chronicle make create_users_table

# 3. Preview SQL before running
chronicle up --dry-run

# 4. Apply migrations
chronicle up

# 5. Check status
chronicle status
```

---

## Configuration

```ts
// chronicle.config.ts
import { defineConfig } from "@chronicle/core";
import { postgres } from "@chronicle/postgres";

export default defineConfig({
  adapter: postgres({
    connectionString: process.env.DATABASE_URL,
    // Connection retry options
    retryAttempts: 3,
    retryBaseDelayMs: 200,
    // Statement timeout per transaction (PostgreSQL SET LOCAL)
    statementTimeoutMs: 30_000,
  }),
  migrations: {
    directory: "database/migrations",  // or ["src/migrations", "plugins/*/migrations"]
    namespace: "default",
  },
  policies: {
    requireDown: true,                   // every migration must have a down()
    preventProductionRollback: true,     // blocks rollback in NODE_ENV=production
  },
  execution: {
    statementTimeoutMs: 30_000,          // overrides adapter default for transactional migrations
    migrationTimeoutMs: 300_000,         // per-migration wall-clock timeout
  },
});
```

---

## Schema DSL

```ts
import { Migration, type MigrationContext } from "@chronicle/core";

export default class CreateUsersTable extends Migration {
  // Required for CREATE INDEX CONCURRENTLY (cannot run inside a transaction)
  readonly transaction = false;

  async up({ schema }: MigrationContext): Promise<void> {
    await schema.createTable("users", (table) => {
      table.uuid("id").primary().defaultRaw("gen_random_uuid()");
      table.string("email", { length: 255 }).notNullable().unique();
      table.string("name", { length: 120 }).notNullable();
      table.enum("status", ["active", "suspended", "archived"]).default("active");
      table.boolean("verified").default(false);
      table.jsonb("metadata").nullable();
      table.timestamps({ withTimezone: true });
      table.softDeletes({ withTimezone: true });
      table.userstamps({ references: { table: "users", onDelete: "set null" } });
      // Composite primary key example (alternative to above uuid primary):
      // table.primary(["tenant_id", "id"]);
      table.check("chk_email_format", "email LIKE '%@%'");
      table.index("email", { concurrently: true, ifNotExists: true });
      table.index(["status", "created_at"]);
    });
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropTable("users", { ifExists: true });
  }
}
```

### Alter Table

```ts
export default class AddPhoneToUsers extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.alterTable("users", (table) => {
      table.string("phone", { length: 20 }).nullable();
      table.addForeignKey("org_id", "organizations", ["id"], {
        onDelete: "cascade",
      });
      table.addCheck("chk_phone_format", "phone ~ '^\\+[0-9]{7,15}$'");
      table.addUniqueConstraint(["email", "org_id"], "users_email_org_unique");
      table.index("phone", { ifNotExists: true });
    });
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.alterTable("users", (table) => {
      table.dropForeignKey("users_org_id_foreign");
      table.dropCheck("chk_phone_format");
      table.dropUniqueConstraint("users_email_org_unique");
      table.dropIndex("users_phone_index");
      table.dropColumn("phone");
    });
  }
}
```

### Column Operations

```ts
await schema.alterTable("users", (table) => {
  table.changeType("age", "bigInteger");                     // ALTER COLUMN TYPE
  table.setNotNullable("name");                              // SET NOT NULL
  table.setNullable("bio");                                  // DROP NOT NULL
  table.setDefault("verified", false);                       // SET DEFAULT
  table.dropDefault("verified");                             // DROP DEFAULT
  table.renameColumn("fname", "first_name");
  table.dropColumn("legacy_field", { ifExists: true });
  table.renameIndex("old_idx_name", "new_idx_name");
});
```

### Other Schema Operations

```ts
await schema.renameTable("user_profiles", "profiles");
await schema.truncate("sessions", { cascade: true, restartIdentity: true });
await schema.createEnum("mood_enum", ["happy", "sad", "neutral"]);
await schema.dropEnum("mood_enum", { ifExists: true });
await schema.raw("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
```

---

## CLI Reference

```
chronicle [options] <command>

Global options:
  -c, --config <path>     Path to chronicle config file
  --cwd <path>            Working directory
  --format <text|json>    Output format (default: text)

Commands:
  init                    Create chronicle.config.ts and migrations directory
  make <name>             Generate a timestamped migration file
  up                      Run pending migrations
  down                    Roll back migrations
  baseline                Mark migrations as applied without running SQL
  status                  Show all migration statuses
  plan                    Preview pending and rollback candidates
  verify                  Exit 1 if drift is detected (CI/CD)

chronicle up [options]
  --step <n>              Apply at most n migrations
  --to <id>               Apply up to and including migration <id>
  --dry-run               Print SQL without mutating the database
  --fake                  Record as applied without executing SQL

chronicle down [options]
  --step <n>              Roll back at most n migrations (default: latest batch)
  --to <id>               Roll back to and including migration <id>
  --dry-run               Print SQL without mutating the database
  --fake                  Remove records without executing SQL
  --force                 Allow rollback in production

chronicle baseline [options]
  --to <id>               Baseline up to and including migration <id>
```

### JSON output for CI/CD

```bash
# Check for drift in CI — exits 1 if any migration is modified or missing
chronicle verify --format json | jq '.ok'

# Get pending migration list as JSON
chronicle status --format json | jq '[.migrations[] | select(.status == "pending")]'

# Dry-run and capture SQL
chronicle up --dry-run --format json | jq '.statements[].sql'
```

---

## Safety Features

### Checksum Drift Detection

Every applied migration's SHA-256 checksum is stored. `chronicle verify` (and every `up`/`down` run) compares stored checksums against the current file contents — if a previously-applied migration was modified, the run is blocked:

```
Migration drift detected: 20260112_create_users:modified
```

### Advisory Locks

`chronicle up` acquires a PostgreSQL advisory lock scoped to the migration namespace before running. Two concurrent deployments cannot run migrations simultaneously — the second waits up to `lockTimeoutMs` (default 30s) then fails with a clear error.

### Production Rollback Guard

With `preventProductionRollback: true`, `chronicle down` throws when `NODE_ENV=production`. Override explicitly with `--force` after manual approval.

### Timeouts

```ts
// chronicle.config.ts
execution: {
  statementTimeoutMs: 30_000,   // PostgreSQL SET LOCAL statement_timeout per transaction
  migrationTimeoutMs: 300_000,  // Wall-clock timeout per migration file
}
```

`execution.statementTimeoutMs` overrides the PostgreSQL adapter's `statementTimeoutMs` default for transactional migrations. Non-transactional migrations do not use `SET LOCAL`.

---

## Adopting an Existing Database

Use `baseline` to mark all existing migrations as applied without running their SQL:

```bash
# Mark every pending migration as applied (useful for first-time chronicle adoption)
chronicle baseline

# Or up to a specific migration
chronicle baseline --to 20260112153045_create_users_table
```

---

## Logging

```ts
import { Migrator, createLogger } from "@chronicle/core";

const migrator = new Migrator(config);

// Attach built-in structured logger
const unsubscribe = createLogger(migrator.events, {
  level: "info",   // "silent" | "error" | "warn" | "info" | "debug"
});

// Or use a custom writer (e.g. pino)
createLogger(migrator.events, {
  level: "debug",
  writer: (entry) => pino[entry.level]({ ...entry.data }, entry.message),
});

await migrator.up();
unsubscribe();
```

---

## Testing Your Migrations

```ts
import { describe, it, expect, afterEach } from "vitest";
import {
  createTestMigrator,
  createMigrationFixtures,
} from "@chronicle/testing";

describe("CreateUsersTable migration", () => {
  let cleanup: () => Promise<void>;

  afterEach(() => cleanup?.());

  it("creates users table and rolls back cleanly", async () => {
    const fixtures = await createMigrationFixtures([
      {
        id: "20260101000001_create_users",
        upSql: "CREATE TABLE users (id uuid PRIMARY KEY)",
        downSql: "DROP TABLE users",
      },
    ]);
    cleanup = fixtures.cleanup;

    const { migrator, adapter } = createTestMigrator({
      directory: fixtures.directory,
    });

    // up
    const upResult = await migrator.up();
    expect(upResult.executions).toHaveLength(1);
    expect(adapter.executedStatements[0].sql).toContain("CREATE TABLE users");

    // status
    const statuses = await migrator.status();
    expect(statuses[0].status).toBe("applied");

    // down
    adapter.clearStatements();
    const downResult = await migrator.down();
    expect(downResult.executions).toHaveLength(1);
    expect(adapter.executedStatements[0].sql).toContain("DROP TABLE users");
  });
});
```

---

## Multi-Namespace / Multi-Tenant

```ts
// Run migrations per-tenant with isolated namespaces
for (const tenant of tenants) {
  const migrator = new Migrator(resolveConfig({
    adapter: postgres({ connectionString: tenant.dbUrl }),
    migrations: {
      directory: "database/migrations",
      namespace: `tenant:${tenant.id}`,
    },
  }));

  await migrator.up();
}
```

See [`examples/multi-tenant`](examples/multi-tenant) for a complete example.

---

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit           # Fast unit tests (no DB required)
pnpm test:integration    # Requires Docker — starts postgres:16-alpine automatically
```

`pnpm test:integration` starts `postgres:16-alpine` via Docker Compose, waits for readiness,
runs the full PostgreSQL integration suite, then removes the container.
Set `CHRONICLE_KEEP_POSTGRES=1` to keep the database running after tests.

See [`examples/postgres-basic`](examples/postgres-basic) for a complete starter project.

---

## License

MIT
