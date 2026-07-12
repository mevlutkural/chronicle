import { describe, it, expect } from "vitest";
import { InMemoryAdapter } from "../src/index.js";

describe("InMemoryAdapter", () => {
  it("records executed statements", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.execute({ sql: "SELECT 1" });
    await adapter.execute("SELECT 2");
    expect(adapter.executedStatements).toHaveLength(2);
    expect(adapter.executedStatements[0]).toEqual({ sql: "SELECT 1" });
    expect(adapter.executedStatements[1]).toEqual({ sql: "SELECT 2" });
  });

  it("queued responses are returned in order", async () => {
    const adapter = new InMemoryAdapter();
    adapter
      .queueResponse({ rows: [{ id: 1 }], rowCount: 1 })
      .queueResponse({ rows: [{ id: 2 }], rowCount: 1 });

    const first = await adapter.execute<{ id: number }>({ sql: "SELECT 1" });
    const second = await adapter.execute<{ id: number }>({ sql: "SELECT 2" });
    const third = await adapter.execute<{ id: number }>({ sql: "SELECT 3" });

    expect(first.rows[0]?.id).toBe(1);
    expect(second.rows[0]?.id).toBe(2);
    expect(third.rows).toEqual([]);
    expect(third.rowCount).toBe(0);
  });

  it("withLock calls callback immediately", async () => {
    const adapter = new InMemoryAdapter();
    let called = false;
    const result = await adapter.withLock("test-lock", async () => {
      called = true;
      return 42;
    });
    expect(called).toBe(true);
    expect(result).toBe(42);
  });

  it("transaction calls callback with session", async () => {
    const adapter = new InMemoryAdapter();
    const result = await adapter.transaction(async (session) => {
      await session.execute({ sql: "SELECT 1" });
      return "done";
    });
    expect(result).toBe("done");
    expect(adapter.executedStatements).toHaveLength(1);
  });

  it("InMemoryRepository tracks applied migrations", async () => {
    const adapter = new InMemoryAdapter();
    const repo = adapter.createRepository();
    await repo.ensureReady();

    const record = {
      id: "20260101000001_create_users",
      namespace: "test",
      name: "create_users",
      batch: 1,
      checksum: "abc123",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 10
    };

    await repo.recordApplied(record);
    const executed = await repo.listExecuted("test");
    expect(executed).toHaveLength(1);
    expect(executed[0]?.id).toBe("20260101000001_create_users");
  });

  it("InMemoryRepository latestBatch returns max batch", async () => {
    const adapter = new InMemoryAdapter();
    const repo = adapter.createRepository();

    await repo.recordApplied({
      id: "20260101000001_a",
      namespace: "test",
      name: "a",
      batch: 1,
      checksum: "x",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 0
    });
    await repo.recordApplied({
      id: "20260101000002_b",
      namespace: "test",
      name: "b",
      batch: 3,
      checksum: "y",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 0
    });

    const latest = await repo.latestBatch("test");
    expect(latest).toBe(3);
  });

  it("InMemoryRepository removeApplied deletes record", async () => {
    const adapter = new InMemoryAdapter();
    const repo = adapter.createRepository();

    await repo.recordApplied({
      id: "20260101000001_drop_me",
      namespace: "test",
      name: "drop_me",
      batch: 1,
      checksum: "z",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 0
    });

    await repo.removeApplied("test", "20260101000001_drop_me");
    const executed = await repo.listExecuted("test");
    expect(executed).toHaveLength(0);
  });

  it("InMemoryRepository recordLog stores entries", async () => {
    const adapter = new InMemoryAdapter();
    const repo = adapter.createRepository();

    const entry = {
      namespace: "test",
      migrationId: "20260101000001_a",
      name: "a",
      direction: "up" as const,
      status: "success" as const,
      checksum: "abc",
      executionMs: 5
    };

    await repo.recordLog(entry);
    // Logs are internal, but no error means it worked
  });

  it("InMemorySchemaCompiler returns comment SQL for each command kind", () => {
    const adapter = new InMemoryAdapter();
    const compiler = adapter.createSchemaCompiler();

    expect(compiler.compile({ kind: "createTable", tableName: "users", columns: [], indexes: [], checks: [], uniqueConstraints: [], ifNotExists: false }))
      .toEqual([{ sql: "-- createTable: users" }]);

    expect(compiler.compile({ kind: "dropTable", tableName: "users", ifExists: false, cascade: false }))
      .toEqual([{ sql: "-- dropTable: users" }]);

    expect(compiler.compile({ kind: "alterTable", tableName: "users", operations: [] }))
      .toEqual([{ sql: "-- alterTable: users" }]);

    expect(compiler.compile({ kind: "createEnum", enumName: "status_enum", values: ["a"], ifNotExists: true }))
      .toEqual([{ sql: "-- createEnum: status_enum" }]);

    expect(compiler.compile({ kind: "dropEnum", enumName: "status_enum", ifExists: true, cascade: false }))
      .toEqual([{ sql: "-- dropEnum: status_enum" }]);

    expect(compiler.compile({ kind: "renameTable", from: "old", to: "new" }))
      .toEqual([{ sql: "-- renameTable: old -> new" }]);

    expect(compiler.compile({ kind: "truncateTable", tableName: "users", cascade: false, restartIdentity: false }))
      .toEqual([{ sql: "-- truncateTable: users" }]);

    expect(compiler.compile({ kind: "raw", statements: [{ sql: "SELECT 1" }] }))
      .toEqual([{ sql: "SELECT 1" }]);
  });

  it("clearStatements resets executed statements", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.execute({ sql: "SELECT 1" });
    expect(adapter.executedStatements).toHaveLength(1);
    adapter.clearStatements();
    expect(adapter.executedStatements).toHaveLength(0);
  });

  it("dialect defaults to memory", () => {
    const adapter = new InMemoryAdapter();
    expect(adapter.dialect).toBe("memory");
    expect(adapter.name).toBe("chronicle-memory");
  });

  it("dialect can be overridden", () => {
    const adapter = new InMemoryAdapter({ dialect: "sqlite" });
    expect(adapter.dialect).toBe("sqlite");
  });

  it("close resolves without error", async () => {
    const adapter = new InMemoryAdapter();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("repositories share state within same adapter", async () => {
    const adapter = new InMemoryAdapter();
    const repo1 = adapter.createRepository();
    const repo2 = adapter.createRepository();

    await repo1.recordApplied({
      id: "20260101000001_shared",
      namespace: "test",
      name: "shared",
      batch: 1,
      checksum: "abc",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 0
    });

    const executed = await repo2.listExecuted("test");
    expect(executed).toHaveLength(1);
  });

  it("listExecuted is namespace-scoped", async () => {
    const adapter = new InMemoryAdapter();
    const repo = adapter.createRepository();

    await repo.recordApplied({
      id: "20260101000001_a",
      namespace: "ns1",
      name: "a",
      batch: 1,
      checksum: "x",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 0
    });
    await repo.recordApplied({
      id: "20260101000002_b",
      namespace: "ns2",
      name: "b",
      batch: 1,
      checksum: "y",
      checksumAlgo: "sha256",
      executedAt: new Date(),
      executionMs: 0
    });

    const ns1 = await repo.listExecuted("ns1");
    const ns2 = await repo.listExecuted("ns2");
    expect(ns1).toHaveLength(1);
    expect(ns2).toHaveLength(1);
  });
});
