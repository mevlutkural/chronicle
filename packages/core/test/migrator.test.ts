import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EventBus,
  Migrator,
  MissingDownMigrationError,
  MigrationTimeoutError,
  ProductionRollbackBlockedError,
  UnsafeSchemaCommandError,
  MigrationDriftError,
  resolveConfig,
  type DatabaseAdapter,
  type DatabaseSession,
  type MigrationLogEntry,
  type MigrationRecord,
  type MigrationRepository,
  type QueryResult,
  type SchemaCommand,
  type SqlStatement
} from "../src/index.js";

describe("Migrator", () => {
  it("plans, verifies, dry-runs, applies, rolls back, and emits events", async () => {
    const directory = await migrationDir({
      "20260101000000_create_users.js": `
        export default {
          async up({ schema, db }) {
            await schema.raw("select up", [1]);
            await db.execute({ sql: "select dry-db", bindings: [2] });
          },
          async down({ schema }) {
            await schema.raw("select down");
          }
        };
      `
    });
    const repository = new MemoryRepository();
    const adapter = new MemoryAdapter(repository);
    const events = new EventBus();
    const eventTypes: string[] = [];
    events.on((event) => {
      eventTypes.push(event.type);
    });
    const migrator = new Migrator(config(adapter, directory), events);

    expect(migrator.events).toBe(events);
    await expect(migrator.status()).resolves.toMatchObject([{ status: "pending" }]);
    await expect(migrator.plan()).resolves.toMatchObject({
      pending: [{ id: "20260101000000_create_users" }],
      rollback: []
    });
    await expect(migrator.verify()).resolves.toMatchObject({ ok: true });

    const dryRun = await migrator.up({ dryRun: true });
    expect(dryRun.statements.map((statement) => statement.sql)).toEqual([
      "select up",
      "select dry-db"
    ]);
    expect(repository.ensureReadyCalls).toBe(0);

    const up = await migrator.up({ step: 1, environment: "test" });
    expect(up.executions).toHaveLength(1);
    expect(repository.records).toHaveLength(1);
    expect(repository.logs.at(-1)).toMatchObject({ direction: "up", status: "success" });
    expect(adapter.lockNames).toEqual(["chronicle:default"]);
    expect(adapter.transactionCalls).toBe(1);

    const down = await migrator.down({ step: 1, force: true, environment: "production" });
    expect(down.executions).toHaveLength(1);
    expect(repository.records).toHaveLength(0);
    expect(repository.logs.at(-1)).toMatchObject({ direction: "down", status: "success" });
    expect(eventTypes).toContain("sql:statement");
  });

  it("handles no-op runs and target migration limits", async () => {
    const directory = await migrationDir({
      "20260101000000_a.js": migrationModule("select a"),
      "20260102000000_b.js": migrationModule("select b")
    });
    const repository = new MemoryRepository();
    const adapter = new MemoryAdapter(repository);
    const migrator = new Migrator(config(adapter, directory));

    expect((await migrator.up({ to: "20260101000000_a" })).executions).toHaveLength(1);
    expect((await migrator.up()).executions).toHaveLength(1);
    expect((await migrator.up()).executions).toHaveLength(0);
  });

  it("plans rollback candidates", async () => {
    const source = migrationModule("select a");
    const directory = await migrationDir({ "20260101000000_a.js": source });
    const repository = new MemoryRepository([record("20260101000000_a", checksum(source))]);
    const migrator = new Migrator(config(new MemoryAdapter(repository), directory));

    await expect(migrator.plan()).resolves.toMatchObject({
      rollback: [{ id: "20260101000000_a" }]
    });
  });

  it("blocks production rollback without force", async () => {
    const migrator = new Migrator(
      config(new MemoryAdapter(new MemoryRepository()), await migrationDir({}))
    );

    await expect(migrator.down({ environment: "production" })).rejects.toThrow(
      ProductionRollbackBlockedError
    );
  });

  it("uses NODE_ENV for production rollback policy", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const migrator = new Migrator(
      config(new MemoryAdapter(new MemoryRepository()), await migrationDir({}))
    );

    try {
      await expect(migrator.down()).rejects.toThrow(ProductionRollbackBlockedError);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("fails rollback when down is required but missing", async () => {
    const source = `export default { async up({ schema }) { await schema.raw("up"); } };`;
    const directory = await migrationDir({
      "20260101000000_create_users.js": source
    });
    const repository = new MemoryRepository([
      record("20260101000000_create_users", checksum(source))
    ]);
    const migrator = new Migrator(config(new MemoryAdapter(repository), directory));

    await expect(migrator.down({ force: true })).rejects.toThrow(MissingDownMigrationError);
  });

  it("allows missing down handlers when policy disables the requirement", async () => {
    const source = `export default { async up({ schema }) { await schema.raw("up"); } };`;
    const directory = await migrationDir({
      "20260101000000_create_users.js": source
    });
    const repository = new MemoryRepository([
      record("20260101000000_create_users", checksum(source))
    ]);
    const resolved = config(new MemoryAdapter(repository), directory);
    const migrator = new Migrator({
      ...resolved,
      policies: { ...resolved.policies, requireDown: false }
    });

    await expect(migrator.down({ force: true })).resolves.toMatchObject({
      executions: [{ direction: "down" }]
    });
  });

  it("reports drift when the migration file is missing", async () => {
    const repository = new MemoryRepository([record("20260101000000_missing", "missing")]);
    const migrator = new Migrator(config(new MemoryAdapter(repository), await migrationDir({})));

    await expect(migrator.down({ force: true })).rejects.toThrow(MigrationDriftError);
  });

  it("records failure logs", async () => {
    const directory = await migrationDir({
      "20260101000000_boom.js": `
        export default {
          async up() {
            throw new Error("boom");
          },
          async down() {}
        };
      `
    });
    const repository = new MemoryRepository();
    const migrator = new Migrator(config(new MemoryAdapter(repository), directory));

    await expect(migrator.up()).rejects.toThrow("boom");
    expect(repository.logs.at(-1)).toMatchObject({ status: "failed", error: "boom" });
  });

  it("emits dry-run failures without writing logs", async () => {
    const directory = await migrationDir({
      "20260101000000_boom.js": `
        export default {
          async up() {
            throw new Error("dry boom");
          },
          async down() {}
        };
      `
    });
    const repository = new MemoryRepository();
    const migrator = new Migrator(config(new MemoryAdapter(repository), directory));

    await expect(migrator.up({ dryRun: true })).rejects.toThrow("dry boom");
    expect(repository.logs).toHaveLength(0);
  });

  it("runs migrations that opt out of transactions", async () => {
    const directory = await migrationDir({
      "20260101000000_no_transaction.js": `
        export default {
          transaction: false,
          async up({ schema }) { await schema.raw("up"); },
          async down({ schema }) { await schema.raw("down"); }
        };
      `
    });
    const adapter = new MemoryAdapter(new MemoryRepository());
    const migrator = new Migrator(config(adapter, directory));

    await migrator.up();

    expect(adapter.transactionCalls).toBe(0);
  });

  it("guards concurrent indexes inside transactions", async () => {
    const directory = await migrationDir({
      "20260101000000_concurrent.js": `
        export default {
          async up({ schema }) {
            await schema.createTable("users", table => {
              table.uuid("id");
              table.index("id", { concurrently: true });
            });
          },
          async down() {}
        };
      `
    });
    const migrator = new Migrator(config(new MemoryAdapter(new MemoryRepository()), directory));

    await expect(migrator.up()).rejects.toThrow(UnsafeSchemaCommandError);
  });

  it("guards concurrent alter-table indexes inside transactions", async () => {
    const directory = await migrationDir({
      "20260101000000_concurrent_alter.js": `
        export default {
          async up({ schema }) {
            await schema.alterTable("users", table => {
              table.index("id", { concurrently: true });
            });
          },
          async down() {}
        };
      `
    });
    const migrator = new Migrator(config(new MemoryAdapter(new MemoryRepository()), directory));

    await expect(migrator.up()).rejects.toThrow(UnsafeSchemaCommandError);
  });

  it("baseline() records migrations without executing SQL", async () => {
    const directory = await migrationDir({
      "20260101000000_a.js": migrationModule("select a"),
      "20260102000000_b.js": migrationModule("select b")
    });
    const repository = new MemoryRepository();
    const adapter = new MemoryAdapter(repository);
    const events = new EventBus();
    const eventTypes: string[] = [];
    events.on((event) => {
      eventTypes.push(event.type);
    });
    const migrator = new Migrator(config(adapter, directory), events);

    const result = await migrator.baseline();

    expect(result.dryRun).toBe(false);
    expect(result.executions).toHaveLength(2);
    expect(result.statements).toHaveLength(0);
    expect(result.executions.every((e) => e.statements.length === 0)).toBe(true);
    expect(repository.records).toHaveLength(2);
    // No SQL executed on the adapter
    expect(adapter.executed).toHaveLength(0);
    expect(eventTypes).toContain("migration:start");
    expect(eventTypes).toContain("migration:success");
  });

  it("baseline() records up to --to migration inclusive", async () => {
    const directory = await migrationDir({
      "20260101000000_a.js": migrationModule("select a"),
      "20260102000000_b.js": migrationModule("select b")
    });
    const repository = new MemoryRepository();
    const migrator = new Migrator(config(new MemoryAdapter(repository), directory));

    await migrator.baseline({ to: "20260101000000_a" });

    expect(repository.records).toHaveLength(1);
    expect(repository.records[0]?.id).toBe("20260101000000_a");
  });

  it("up({ fake: true }) records metadata without running migration code", async () => {
    const directory = await migrationDir({
      "20260101000000_a.js": migrationModule("select a")
    });
    const repository = new MemoryRepository();
    const adapter = new MemoryAdapter(repository);
    const migrator = new Migrator(config(adapter, directory));

    const result = await migrator.up({ fake: true });

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.statements).toHaveLength(0);
    expect(repository.records).toHaveLength(1);
    // No SQL executed on the adapter during migration
    expect(adapter.executed).toHaveLength(0);
  });

  it("down({ fake: true }) removes metadata without running migration code", async () => {
    const source = migrationModule("select a");
    const directory = await migrationDir({ "20260101000000_a.js": source });
    const repository = new MemoryRepository([record("20260101000000_a", checksum(source))]);
    const adapter = new MemoryAdapter(repository);
    const migrator = new Migrator(config(adapter, directory));

    const result = await migrator.down({ fake: true, force: true });

    expect(result.executions).toHaveLength(1);
    expect(repository.records).toHaveLength(0);
    expect(adapter.executed).toHaveLength(0);
  });

  it("up({ fake: true, dryRun: true }) throws an error", async () => {
    const directory = await migrationDir({
      "20260101000000_a.js": migrationModule("select a")
    });
    const migrator = new Migrator(config(new MemoryAdapter(new MemoryRepository()), directory));

    await expect(migrator.up({ fake: true, dryRun: true })).rejects.toThrow(MigrationDriftError);
  });

  it("throws MigrationTimeoutError when migrationTimeoutMs is exceeded", async () => {
    const directory = await migrationDir({
      "20260101000000_slow.js": `
        export default {
          async up() {
            await new Promise((resolve) => setTimeout(resolve, 500));
          },
          async down() {}
        };
      `
    });
    const repository = new MemoryRepository();
    const adapter = new MemoryAdapter(repository);
    const resolved = config(adapter, directory);
    const migrator = new Migrator({
      ...resolved,
      execution: { statementTimeoutMs: undefined, migrationTimeoutMs: 50 }
    });

    await expect(migrator.up()).rejects.toThrow(MigrationTimeoutError);
  });

  it("resolves statementTimeoutMs in ResolvedChronicleConfig.execution", () => {
    const adapter = new MemoryAdapter(new MemoryRepository());
    const resolved = resolveConfig({
      adapter,
      execution: { statementTimeoutMs: 30_000, migrationTimeoutMs: 300_000 }
    });

    expect(resolved.execution.statementTimeoutMs).toBe(30_000);
    expect(resolved.execution.migrationTimeoutMs).toBe(300_000);
  });
});

function config(adapter: DatabaseAdapter, directory: string) {
  return resolveConfig({
    adapter,
    migrations: { directory, namespace: "default" }
  });
}

function migrationModule(sql: string): string {
  return `export default {
    async up({ schema }) { await schema.raw("${sql}"); },
    async down({ schema }) { await schema.raw("${sql} down"); }
  };`;
}

async function migrationDir(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chronicle-migrator-"));

  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(directory, name), contents))
  );

  return directory;
}

function record(id: string, checksumValue: string, batch = 1): MigrationRecord {
  return {
    id,
    namespace: "default",
    name: id,
    batch,
    checksum: checksumValue,
    checksumAlgo: "sha256",
    executedAt: new Date("2026-01-01T00:00:00.000Z"),
    executionMs: 1
  };
}

function checksum(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}

class MemoryRepository implements MigrationRepository {
  ensureReadyCalls = 0;
  readonly records: MigrationRecord[];
  readonly logs: MigrationLogEntry[] = [];

  constructor(records: MigrationRecord[] = []) {
    this.records = [...records];
  }

  async ensureReady(): Promise<void> {
    this.ensureReadyCalls += 1;
  }

  async listExecuted(namespace: string): Promise<readonly MigrationRecord[]> {
    return this.records.filter((record) => record.namespace === namespace);
  }

  async latestBatch(namespace: string): Promise<number> {
    return Math.max(
      0,
      ...this.records
        .filter((record) => record.namespace === namespace)
        .map((record) => record.batch)
    );
  }

  async recordApplied(recordValue: MigrationRecord): Promise<void> {
    this.records.push(recordValue);
  }

  async removeApplied(namespace: string, migrationId: string): Promise<void> {
    const index = this.records.findIndex(
      (recordValue) => recordValue.namespace === namespace && recordValue.id === migrationId
    );

    if (index >= 0) {
      this.records.splice(index, 1);
    }
  }

  async recordLog(entry: MigrationLogEntry): Promise<void> {
    this.logs.push(entry);
  }
}

class MemoryAdapter implements DatabaseAdapter, DatabaseSession {
  readonly name = "memory";
  readonly dialect = "memory";
  readonly executed: SqlStatement[] = [];
  readonly lockNames: string[] = [];
  transactionCalls = 0;

  constructor(private readonly repository: MemoryRepository) {}

  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement | string
  ): Promise<QueryResult<Row>> {
    this.executed.push(typeof statement === "string" ? { sql: statement } : statement);
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return callback(this);
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    this.lockNames.push(lockName);
    return callback();
  }

  createRepository(): MigrationRepository {
    return this.repository;
  }

  createSchemaCompiler() {
    return {
      compile(command: SchemaCommand): readonly SqlStatement[] {
        if (command.kind === "raw") {
          return command.statements;
        }

        return [{ sql: command.kind }];
      }
    };
  }

  async close(): Promise<void> {}
}
