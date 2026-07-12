import { describe, it, expect } from "vitest";
import { createTestMigrator, createMigrationFixtures } from "../src/index.js";
import { InMemoryAdapter } from "../src/index.js";

describe("createTestMigrator", () => {
  it("returns migrator and adapter", () => {
    const { migrator, adapter } = createTestMigrator();
    expect(migrator).toBeDefined();
    expect(adapter).toBeInstanceOf(InMemoryAdapter);
  });

  it("accepts a custom adapter", () => {
    const custom = new InMemoryAdapter({ dialect: "custom" });
    const { adapter } = createTestMigrator({ adapter: custom });
    expect(adapter).toBe(custom);
    expect(adapter.dialect).toBe("custom");
  });

  it("runs migrations with InMemoryAdapter", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      {
        id: "20260101000001_create_users",
        upSql: "CREATE TABLE users (id uuid PRIMARY KEY)",
        downSql: "DROP TABLE users"
      }
    ]);

    const { migrator, adapter } = createTestMigrator({ directory });
    const upResult = await migrator.up();

    expect(upResult.executions).toHaveLength(1);
    expect(upResult.executions[0]?.id).toBe("20260101000001_create_users");
    // The SQL goes through db.execute, so it should appear in executedStatements
    expect(adapter.executedStatements.some((s) => s.sql.includes("CREATE TABLE users"))).toBe(true);

    adapter.clearStatements();

    const downResult = await migrator.down();
    expect(downResult.executions).toHaveLength(1);
    expect(adapter.executedStatements.some((s) => s.sql.includes("DROP TABLE users"))).toBe(true);

    await cleanup();
  });

  it("baseline marks migrations as applied without running SQL", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      {
        id: "20260101000001_create_users",
        upSql: "CREATE TABLE users (id uuid PRIMARY KEY)"
      }
    ]);

    const { migrator, adapter } = createTestMigrator({ directory });
    const result = await migrator.baseline();

    expect(result.executions).toHaveLength(1);
    // baseline does not execute SQL statements
    expect(adapter.executedStatements).toHaveLength(0);

    await cleanup();
  });

  it("status returns pending migrations before up", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      { id: "20260101000001_create_users" },
      { id: "20260101000002_create_posts" }
    ]);

    const { migrator } = createTestMigrator({ directory });
    const statuses = await migrator.status();

    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s.status === "pending")).toBe(true);

    await cleanup();
  });

  it("namespace can be customized", () => {
    const { migrator } = createTestMigrator({ namespace: "my-app" });
    expect(migrator).toBeDefined();
  });
});
