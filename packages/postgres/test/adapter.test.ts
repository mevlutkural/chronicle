import { describe, expect, it } from "vitest";
import { MigrationLockTimeoutError } from "@chronicle/core";
import { PostgresAdapter, PostgresSession, postgres } from "../src/index.js";
import type { Pool, PoolClient } from "pg";

describe("PostgresAdapter", () => {
  it("executes string and object statements", async () => {
    const pool = new FakePool();
    const adapter = new PostgresAdapter({ pool: pool as unknown as Pool });

    pool.queryResults.push({ rows: [{ ok: true }], rowCount: 1 });
    await expect(adapter.execute<{ ok: boolean }>("select 1")).resolves.toEqual({
      rows: [{ ok: true }],
      rowCount: 1
    });
    pool.queryResults.push({ rows: [], rowCount: null });
    await expect(adapter.execute({ sql: "select $1", bindings: [1] })).resolves.toEqual({
      rows: [],
      rowCount: 0
    });
    expect(pool.queries.map((query) => query.sql)).toEqual(["select 1", "select $1"]);
  });

  it("commits and rolls back transactions", async () => {
    const pool = new FakePool();
    const adapter = new PostgresAdapter({ pool: pool as unknown as Pool });

    await expect(
      adapter.transaction(async (session) => session.execute("select 1"))
    ).resolves.toEqual({
      rows: [],
      rowCount: 0
    });
    expect(pool.client.queries.map((query) => query.sql)).toEqual(["BEGIN", "select 1", "COMMIT"]);
    expect(pool.client.released).toBe(1);

    await expect(
      adapter.transaction(async () => {
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(pool.client.queries.map((query) => query.sql)).toContain("ROLLBACK");
  });

  it("uses execution-level statement timeout before adapter defaults", async () => {
    const pool = new FakePool();
    const adapter = new PostgresAdapter({
      pool: pool as unknown as Pool,
      statementTimeoutMs: 5_000
    });

    await adapter.transaction(async () => {}, { statementTimeoutMs: 1_500 });
    await adapter.transaction(async () => {});

    expect(pool.client.queries.map((query) => query.sql)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 1500",
      "COMMIT",
      "BEGIN",
      "SET LOCAL statement_timeout = 5000",
      "COMMIT"
    ]);
  });

  it("acquires advisory locks, times out, and unlocks in finally", async () => {
    const pool = new FakePool();
    const adapter = new PostgresAdapter({
      pool: pool as unknown as Pool,
      lockTimeoutMs: 0,
      lockPollIntervalMs: 0
    });

    pool.client.queryResults.push({ rows: [{ locked: true }], rowCount: 1 });
    await expect(adapter.withLock("lock-a", async () => "ok")).resolves.toBe("ok");
    expect(pool.client.queries.some((query) => query.sql.includes("pg_advisory_unlock"))).toBe(
      true
    );

    pool.client.queryResults.push(
      { rows: [{ locked: false }], rowCount: 1 },
      { rows: [{ locked: true }], rowCount: 1 }
    );
    await expect(
      new PostgresAdapter({
        pool: pool as unknown as Pool,
        lockTimeoutMs: 1_000,
        lockPollIntervalMs: 0
      }).withLock("lock-c", async () => "eventual")
    ).resolves.toBe("eventual");

    pool.client.queryResults.push({ rows: [{ locked: false }], rowCount: 1 });
    await expect(adapter.withLock("lock-b", async () => "nope")).rejects.toThrow(
      MigrationLockTimeoutError
    );

    pool.client.queryResults.push({ rows: [{ locked: true }], rowCount: 1 });
    pool.client.failUnlock = true;
    await expect(adapter.withLock("lock-d", async () => "unlock ignored")).resolves.toBe(
      "unlock ignored"
    );
  });

  it("retries execute on transient postgres errors then succeeds", async () => {
    const pool = new FakePool();
    const adapter = new PostgresAdapter({
      pool: pool as unknown as Pool,
      retryAttempts: 3,
      retryBaseDelayMs: 0
    });

    // First call throws a transient connection error, second succeeds
    let attempt = 0;
    const originalQuery = pool.query.bind(pool);
    pool.query = async (sql: string, bindings: unknown[] = []) => {
      attempt += 1;
      if (attempt === 1) {
        const err = Object.assign(new Error("connection reset"), { code: "08006" });
        throw err;
      }
      return originalQuery(sql, bindings);
    };

    pool.queryResults.push({ rows: [{ ok: true }], rowCount: 1 });
    const result = await adapter.execute<{ ok: boolean }>("select 1");
    expect(result.rows).toEqual([{ ok: true }]);
    expect(attempt).toBe(2);
  });

  it("withLock timeout message includes elapsed time", async () => {
    const pool = new FakePool();
    const adapter = new PostgresAdapter({
      pool: pool as unknown as Pool,
      lockTimeoutMs: 0,
      lockPollIntervalMs: 0
    });

    pool.client.queryResults.push({ rows: [{ locked: false }], rowCount: 1 });

    let caughtMessage = "";
    try {
      await adapter.withLock("test-lock", async () => "nope");
    } catch (error) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    }

    expect(caughtMessage).toContain("test-lock");
    expect(caughtMessage).toMatch(/after \d+ms/);
    expect(caughtMessage).toContain("Another chronicle process");
  });

  it("creates collaborator objects and closes owned pools", async () => {
    const adapter = postgres();
    const pooled = new PostgresAdapter({ pool: new FakePool() as unknown as Pool });

    expect(adapter.createRepository()).toBeTruthy();
    expect(adapter.createSchemaCompiler()).toBeTruthy();
    await expect(pooled.close()).resolves.toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe("PostgresSession", () => {
  it("executes through its transaction client", async () => {
    const client = new FakeClient();
    const session = new PostgresSession(client as unknown as PoolClient);

    client.queryResults.push({ rows: [{ value: 1 }], rowCount: null });
    await expect(
      session.execute<{ value: number }>({ sql: "select $1", bindings: [1] })
    ).resolves.toEqual({
      rows: [{ value: 1 }],
      rowCount: 0
    });
  });
});

class FakePool {
  readonly queries: { sql: string; bindings: unknown[] }[] = [];
  readonly queryResults: { rows: Record<string, unknown>[]; rowCount: number | null }[] = [];
  readonly client = new FakeClient();

  async query(sql: string, bindings: unknown[] = []) {
    this.queries.push({ sql, bindings });
    return this.queryResults.shift() ?? { rows: [], rowCount: 0 };
  }

  async connect() {
    return this.client;
  }
}

class FakeClient {
  readonly queries: { sql: string; bindings: unknown[] }[] = [];
  readonly queryResults: { rows: Record<string, unknown>[]; rowCount: number | null }[] = [];
  failUnlock = false;
  released = 0;

  async query(sql: string, bindings: unknown[] = []) {
    this.queries.push({ sql, bindings });

    if (this.failUnlock && sql.includes("pg_advisory_unlock")) {
      throw new Error("unlock failed");
    }

    return this.queryResults.shift() ?? { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released += 1;
  }
}
