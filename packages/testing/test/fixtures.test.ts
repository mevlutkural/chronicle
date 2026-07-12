import { describe, it, expect } from "vitest";
import { createMigrationFixtures } from "../src/index.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

describe("createMigrationFixtures", () => {
  it("creates migration files in temp directory", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      { id: "20260101000001_create_users" },
      { id: "20260101000002_create_posts" }
    ]);

    expect(existsSync(directory)).toBe(true);
    expect(existsSync(path.join(directory, "20260101000001_create_users.js"))).toBe(true);
    expect(existsSync(path.join(directory, "20260101000002_create_posts.js"))).toBe(true);

    await cleanup();
  });

  it("cleanup removes directory", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      { id: "20260101000001_temp" }
    ]);

    expect(existsSync(directory)).toBe(true);
    await cleanup();
    expect(existsSync(directory)).toBe(false);
  });

  it("generated files have correct content", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      {
        id: "20260101000001_create_users",
        upSql: "CREATE TABLE users (id uuid PRIMARY KEY)",
        downSql: "DROP TABLE users"
      }
    ]);

    const content = readFileSync(
      path.join(directory, "20260101000001_create_users.js"),
      "utf8"
    );

    expect(content).toContain("CREATE TABLE users (id uuid PRIMARY KEY)");
    expect(content).toContain("DROP TABLE users");
    expect(content).toContain("import { Migration } from");
    expect(content).toContain("async up(context)");
    expect(content).toContain("async down(context)");

    await cleanup();
  });

  it("no-op migration has comment placeholders", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      { id: "20260101000001_noop" }
    ]);

    const content = readFileSync(
      path.join(directory, "20260101000001_noop.js"),
      "utf8"
    );

    expect(content).toContain("// up: no-op");
    expect(content).toContain("// down: no-op");

    await cleanup();
  });

  it("transaction=false is reflected in generated file", async () => {
    const { directory, cleanup } = await createMigrationFixtures([
      { id: "20260101000001_no_tx", transaction: false }
    ]);

    const content = readFileSync(
      path.join(directory, "20260101000001_no_tx.js"),
      "utf8"
    );

    expect(content).toContain("readonly transaction = false");

    await cleanup();
  });
});
