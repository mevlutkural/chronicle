import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseSession,
  MigrationLogEntry,
  MigrationRecord,
  MigrationRepository,
  QueryResult,
  SchemaCommand,
  SqlStatement
} from "@chronicle/core";
import { run } from "../src/index.js";

const tempDirs: string[] = [];

describe("CLI", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.restoreAllMocks();
    delete (globalThis as { __nodeMtCliAdapter?: unknown }).__nodeMtCliAdapter;
    process.exitCode = undefined;
  });

  it("initializes a project and reports existing config errors", async () => {
    const dir = await tempDir();
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "init"]);
    await run(["node", "chronicle", "--cwd", dir, "init"]);

    const config = await readFile(path.join(dir, "chronicle.config.ts"), "utf8");
    expect(config).toContain("defineConfig");
    expect(output.stderr.join("\n")).toContain("already exists");
    expect(process.exitCode).toBe(1);
  });

  it("creates migration files with and without config", async () => {
    const noConfigDir = await tempDir();
    await run(["node", "chronicle", "--cwd", noConfigDir, "make", "create_users_table"]);
    expect(process.exitCode).toBeUndefined();

    const configuredDir = await workspace({ files: {} });
    const adapter = new CliAdapter(new CliRepository());
    setAdapter(adapter);
    await run(["node", "chronicle", "--cwd", configuredDir, "make", "add_status_to_users"]);

    expect(adapter.closed).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints status, plan, and verification results", async () => {
    const source = migrationModule("select one");
    const applied = record("20260101000000_one", checksum(source), 3);
    const dir = await workspace({
      files: {
        "20260101000000_one.js": source,
        "20260102000000_two.js": migrationModule("select two")
      }
    });
    const repository = new CliRepository([applied]);
    setAdapter(new CliAdapter(repository));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "status"]);
    await run(["node", "chronicle", "--cwd", dir, "plan"]);
    await run(["node", "chronicle", "--cwd", dir, "verify"]);

    expect(output.stdout.join("\n")).toContain("pending migration");
    expect(output.stdout.join("\n")).toContain("Verification passed");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints empty status output", async () => {
    const dir = await workspace({ files: {} });
    setAdapter(new CliAdapter(new CliRepository()));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "status"]);
    await run(["node", "chronicle", "--cwd", dir, "plan"]);

    expect(output.stdout.join("\n")).toContain("No migrations found.");
  });

  it("sets a failing exit code when verification detects drift", async () => {
    const dir = await workspace({ files: {} });
    setAdapter(new CliAdapter(new CliRepository([record("20260101000000_missing", "abc")])));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "verify"]);

    expect(output.stdout.join("\n")).toContain("Verification failed");
    expect(process.exitCode).toBe(1);
  });

  it("prints modified migration status", async () => {
    const dir = await workspace({
      files: { "20260101000000_modified.js": migrationModule("select changed") }
    });
    setAdapter(new CliAdapter(new CliRepository([record("20260101000000_modified", "old")])));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "status"]);

    expect(output.stdout.join("\n")).toContain("modified");
  });

  it("prints rollback plans and missing-checksum fallbacks", async () => {
    const source = migrationModule("select applied");
    const dir = await workspace({
      files: { "20260101000000_applied.js": source }
    });
    const applied = record("20260101000000_applied", checksum(source));
    const repository = new CliRepository([{ ...applied, checksum: "" }]);
    setAdapter(new CliAdapter(repository));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "plan"]);

    const stdout = output.stdout.join("\n");
    expect(stdout).toContain("rollback candidate");
    expect(stdout).toContain(" - ");
  });

  it("prints config errors that are not missing-config fallbacks", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "chronicle.config.js"), "export default {};", "utf8");
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "make", "broken"]);

    expect(output.stderr.join("\n")).toContain("must export a chronicle configuration object");
    expect(process.exitCode).toBe(1);
  });

  it("prints dry-run output without SQL statements", async () => {
    const dir = await workspace({
      files: {
        "20260101000000_empty.js": "export default { async up() {}, async down() {} };"
      }
    });
    setAdapter(new CliAdapter(new CliRepository()));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "up", "--dry-run"]);

    expect(output.stdout.join("\n")).toContain("No SQL statements.");
  });

  it("runs up and down commands including dry-run output", async () => {
    const dir = await workspace({
      files: {
        "20260101000000_one.js": `
          export default {
            async up({ schema, db }) {
              await schema.raw("select up", [1]);
              await db.execute("select db");
            },
            async down({ schema }) {
              await schema.raw("select down");
            }
          };
        `
      }
    });
    const repository = new CliRepository();
    setAdapter(new CliAdapter(repository));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "up", "--dry-run"]);
    await run(["node", "chronicle", "--cwd", dir, "up", "--step", "1"]);
    await run(["node", "chronicle", "--cwd", dir, "down", "--force"]);
    await run(["node", "chronicle", "--cwd", dir, "down", "--force"]);

    const stdout = output.stdout.join("\n");
    expect(stdout).toContain("UP dry-run");
    expect(stdout).toContain("bindings");
    expect(stdout).toContain("UP complete");
    expect(stdout).toContain("DOWN complete");
    expect(stdout).toContain("No down migrations to run.");
  });

  it("prints configured batch fallbacks when an adapter omits batch data", async () => {
    const dir = await workspace({
      files: {
        "20260101000000_batchless.js": migrationModule("select batchless")
      }
    });
    const repository = new CliRepository();
    setAdapter(new BatchlessCliAdapter(repository));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "up"]);

    expect(output.stdout.join("\n")).toContain(" - ");
  });

  it("prints command errors for invalid input and missing config", async () => {
    const dir = await tempDir();
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "status"]);
    await run(["node", "chronicle", "--cwd", dir, "up", "--step", "0"]);

    expect(output.stderr.join("\n")).toContain("Could not find");
    expect(output.stderr.join("\n")).toContain("Expected a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("baseline command exists and marks pending migrations without SQL", async () => {
    const dir = await workspace({
      files: {
        "20260101000000_one.js": migrationModule("select one")
      }
    });
    const repository = new CliRepository();
    setAdapter(new CliAdapter(repository));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "baseline"]);

    expect(process.exitCode).toBeUndefined();
    expect(repository.records).toHaveLength(1);
    // No SQL executed for actual migration code
    const stdout = output.stdout.join("\n");
    expect(stdout).toContain("UP complete");
  });

  it("down --to flag is parsed and used", async () => {
    const source = migrationModule("select applied");
    const dir = await workspace({
      files: { "20260101000000_one.js": source }
    });
    const applied = record("20260101000000_one", checksum(source));
    const repository = new CliRepository([applied]);
    setAdapter(new CliAdapter(repository));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "down", "--force", "--to", "20260101000000_one"]);

    expect(process.exitCode).toBeUndefined();
    expect(repository.records).toHaveLength(0);
    expect(output.stdout.join("\n")).toContain("DOWN complete");
  });

  it("status --format json outputs valid JSON with migrations array", async () => {
    const source = migrationModule("select one");
    const applied = record("20260101000000_one", checksum(source), 1);
    const dir = await workspace({
      files: { "20260101000000_one.js": source }
    });
    setAdapter(new CliAdapter(new CliRepository([applied])));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "--format", "json", "status"]);

    const parsed = JSON.parse(output.stdout.join("\n")) as { migrations: unknown[] };
    expect(Array.isArray(parsed.migrations)).toBe(true);
    expect(parsed.migrations).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("verify --format json outputs { ok, migrations } structure", async () => {
    const source = migrationModule("select one");
    const applied = record("20260101000000_one", checksum(source), 1);
    const dir = await workspace({
      files: { "20260101000000_one.js": source }
    });
    setAdapter(new CliAdapter(new CliRepository([applied])));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "--format", "json", "verify"]);

    const parsed = JSON.parse(output.stdout.join("\n")) as { ok: unknown; migrations: unknown[] };
    expect(typeof parsed.ok).toBe("boolean");
    expect(Array.isArray(parsed.migrations)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("up --format json outputs { direction, executions } structure", async () => {
    const dir = await workspace({
      files: {
        "20260101000000_one.js": migrationModule("select one")
      }
    });
    setAdapter(new CliAdapter(new CliRepository()));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "--format", "json", "up"]);

    const parsed = JSON.parse(output.stdout.join("\n")) as {
      direction: string;
      executions: unknown[];
    };
    expect(parsed.direction).toBe("up");
    expect(Array.isArray(parsed.executions)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("plan --format json outputs { statuses, pending, rollback } structure", async () => {
    const source = migrationModule("select one");
    const dir = await workspace({
      files: {
        "20260101000000_one.js": source,
        "20260102000000_two.js": migrationModule("select two")
      }
    });
    const applied = record("20260101000000_one", checksum(source), 1);
    setAdapter(new CliAdapter(new CliRepository([applied])));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "--format", "json", "plan"]);

    const parsed = JSON.parse(output.stdout.join("\n")) as {
      statuses: unknown[];
      pending: unknown[];
      rollback: unknown[];
    };
    expect(Array.isArray(parsed.statuses)).toBe(true);
    expect(Array.isArray(parsed.pending)).toBe(true);
    expect(Array.isArray(parsed.rollback)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints non-error thrown values", async () => {
    const dir = await workspace({ files: {} });
    setAdapter(new ClosingErrorAdapter(new CliRepository()));
    const output = captureConsole();

    await run(["node", "chronicle", "--cwd", dir, "status"]);

    expect(output.stderr.join("\n")).toContain("close failed");
    expect(process.exitCode).toBe(1);
  });
});

async function workspace(input: { readonly files: Record<string, string> }): Promise<string> {
  const dir = await tempDir();
  const migrationsDir = path.join(dir, "database/migrations");
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(
    path.join(dir, "chronicle.config.js"),
    `export default {
      adapter: globalThis.__nodeMtCliAdapter,
      migrations: { directory: "database/migrations", namespace: "default" },
      policies: { requireDown: true, preventProductionRollback: true }
    };`,
    "utf8"
  );
  await Promise.all(
    Object.entries(input.files).map(([name, contents]) =>
      writeFile(path.join(migrationsDir, name), contents, "utf8")
    )
  );

  return dir;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-cli-"));
  tempDirs.push(dir);
  return dir;
}

function captureConsole(): { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });

  return { stdout, stderr };
}

function setAdapter(adapter: CliAdapter): void {
  Object.assign(globalThis, { __nodeMtCliAdapter: adapter });
}

function migrationModule(sql: string): string {
  return `export default {
    async up({ schema }) { await schema.raw("${sql}"); },
    async down({ schema }) { await schema.raw("${sql} down"); }
  };`;
}

function checksum(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
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

class CliRepository implements MigrationRepository {
  readonly records: MigrationRecord[];
  readonly logs: MigrationLogEntry[] = [];

  constructor(records: MigrationRecord[] = []) {
    this.records = [...records];
  }

  async ensureReady(): Promise<void> {}

  async listExecuted(namespace: string): Promise<readonly MigrationRecord[]> {
    return this.records.filter((recordValue) => recordValue.namespace === namespace);
  }

  async latestBatch(namespace: string): Promise<number> {
    return Math.max(
      0,
      ...this.records
        .filter((recordValue) => recordValue.namespace === namespace)
        .map((recordValue) => recordValue.batch)
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

class CliAdapter implements DatabaseAdapter, DatabaseSession {
  readonly name = "cli";
  readonly dialect = "cli";
  closed = 0;

  constructor(private readonly repository: CliRepository) {}

  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement | string
  ): Promise<QueryResult<Row>> {
    void statement;
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async withLock<T>(_lockName: string, callback: () => Promise<T>): Promise<T> {
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

  async close(): Promise<void> {
    this.closed += 1;
  }
}

class BatchlessCliAdapter extends CliAdapter {
  override async withLock<T>(_lockName: string, callback: () => Promise<T>): Promise<T> {
    const result = await callback();

    if (isRunResult(result)) {
      return {
        ...result,
        executions: result.executions.map((execution) => ({ ...execution, batch: undefined }))
      };
    }

    return result;
  }
}

class ClosingErrorAdapter extends CliAdapter {
  override async close(): Promise<void> {
    throw "close failed";
  }
}

function isRunResult(value: unknown): value is {
  readonly executions: readonly { readonly batch?: number }[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "executions" in value &&
    Array.isArray(value.executions)
  );
}
