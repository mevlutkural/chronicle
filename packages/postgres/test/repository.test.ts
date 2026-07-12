import { describe, expect, it } from "vitest";
import { PostgresMigrationRepository, type PostgresAdapter } from "../src/index.js";
import type { MigrationLogEntry, MigrationRecord, QueryResult, SqlStatement } from "@chronicle/core";

describe("PostgresMigrationRepository", () => {
  it("creates tables and records migration state", async () => {
    const adapter = new RecordingAdapter();
    const repository = new PostgresMigrationRepository(adapter as unknown as PostgresAdapter);
    const record: MigrationRecord = {
      id: "1",
      namespace: "default",
      name: "one",
      batch: 1,
      checksum: "abc",
      checksumAlgo: "sha256",
      executedAt: new Date("2026-01-01T00:00:00.000Z"),
      executionMs: 10
    };
    const log: MigrationLogEntry = {
      namespace: "default",
      migrationId: "1",
      name: "one",
      direction: "up",
      status: "success",
      checksum: "abc",
      executionMs: 10
    };

    await repository.ensureReady();
    await repository.recordApplied(record);
    await repository.removeApplied("default", "1");
    await repository.recordLog(log);

    expect(adapter.statements).toHaveLength(9); // ensureReady: CREATE migrations, ALTER TABLE, CREATE log, 3× CREATE INDEX; recordApplied; removeApplied; recordLog
    expect(adapter.statements.at(-1)?.bindings?.at(-1)).toBe("{}");
  });

  it("lists executed migrations and latest batch", async () => {
    const adapter = new RecordingAdapter();
    const repository = new PostgresMigrationRepository(adapter as unknown as PostgresAdapter);
    const date = new Date("2026-01-01T00:00:00.000Z");

    adapter.results.push({
      rows: [
        {
          id: "1",
          namespace: "default",
          name: "one",
          batch: 2,
          checksum: "abc",
          checksum_algo: "sha256",
          executed_at: date,
          execution_ms: 12
        }
      ],
      rowCount: 1
    });
    await expect(repository.listExecuted("default")).resolves.toEqual([
      {
        id: "1",
        namespace: "default",
        name: "one",
        batch: 2,
        checksum: "abc",
        checksumAlgo: "sha256",
        executedAt: date,
        executionMs: 12
      }
    ]);

    adapter.results.push({ rows: [{ batch: 2 }], rowCount: 1 });
    await expect(repository.latestBatch("default")).resolves.toBe(2);
    adapter.results.push({ rows: [{ batch: null }], rowCount: 1 });
    await expect(repository.latestBatch("default")).resolves.toBe(0);
  });

  it("treats missing state tables as empty and rethrows other errors", async () => {
    const adapter = new RecordingAdapter();
    const repository = new PostgresMigrationRepository(adapter as unknown as PostgresAdapter);
    const undefinedTable = Object.assign(new Error("missing"), { code: "42P01" });

    adapter.errors.push(undefinedTable);
    await expect(repository.listExecuted("default")).resolves.toEqual([]);
    adapter.errors.push(undefinedTable);
    await expect(repository.latestBatch("default")).resolves.toBe(0);

    adapter.errors.push(new Error("boom"));
    await expect(repository.listExecuted("default")).rejects.toThrow("boom");
    adapter.errors.push(new Error("boom"));
    await expect(repository.latestBatch("default")).rejects.toThrow("boom");
  });
});

class RecordingAdapter {
  readonly statements: SqlStatement[] = [];
  readonly results: QueryResult[] = [];
  readonly errors: unknown[] = [];

  async execute(statement: SqlStatement | string): Promise<QueryResult> {
    const error = this.errors.shift();

    if (error) {
      throw error;
    }

    this.statements.push(typeof statement === "string" ? { sql: statement } : statement);
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}
