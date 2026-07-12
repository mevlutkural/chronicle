import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidMigrationError, MigrationLoader, normalizeMigrationSource } from "../src/index.js";

describe("normalizeMigrationSource", () => {
  it("normalizes line endings and trailing whitespace before checksum", () => {
    expect(normalizeMigrationSource("a\r\nb\r\n")).toBe("a\nb");
  });
});

describe("MigrationLoader", () => {
  it("loads sorted migrations and instantiates class and object exports", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(path.join(dir, "ignored.txt"), "nope", "utf8");
    await writeFile(
      path.join(dir, "20260102000000_second.js"),
      "export default { async up() {} };",
      "utf8"
    );
    await writeFile(
      path.join(dir, "20260101000000_first.js"),
      "export default class First { async up() {} }",
      "utf8"
    );

    const migrations = await new MigrationLoader({ directory: dir }).load();

    expect(migrations.map((migration) => migration.id)).toEqual([
      "20260101000000_first",
      "20260102000000_second"
    ]);
    await expect(migrations[0]?.create()).resolves.toHaveProperty("up");
    await expect(migrations[1]?.create()).resolves.toHaveProperty("up");
  });

  it("loads CommonJS migration exports directly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(
      path.join(dir, "20260101000000_cjs.cjs"),
      "module.exports = { async up() {} };"
    );
    const [migration] = await new MigrationLoader({ directory: dir }).load();

    await expect(migration?.create()).resolves.toHaveProperty("up");
  });

  it("loads named-export migration objects directly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(path.join(dir, "20260101000000_named.js"), "export async function up() {};");
    const [migration] = await new MigrationLoader({ directory: dir }).load();

    await expect(migration?.create()).resolves.toHaveProperty("up");
  });

  it("loads migrations from multiple directories sorted globally by id", async () => {
    const dir1 = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    const dir2 = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(
      path.join(dir1, "20260101000000_first.js"),
      "export default { async up() {} };",
      "utf8"
    );
    await writeFile(
      path.join(dir2, "20260103000000_third.js"),
      "export default { async up() {} };",
      "utf8"
    );
    await writeFile(
      path.join(dir1, "20260102000000_second.js"),
      "export default { async up() {} };",
      "utf8"
    );

    const migrations = await new MigrationLoader({ directory: [dir1, dir2] }).load();
    expect(migrations.map((m) => m.id)).toEqual([
      "20260101000000_first",
      "20260102000000_second",
      "20260103000000_third"
    ]);
  });

  it("rejects duplicate ids across multiple directories", async () => {
    const dir1 = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    const dir2 = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(
      path.join(dir1, "20260101000000_same.js"),
      "export default { async up() {} };",
      "utf8"
    );
    await writeFile(
      path.join(dir2, "20260101000000_same.js"),
      "export default { async up() {} };",
      "utf8"
    );

    await expect(new MigrationLoader({ directory: [dir1, dir2] }).load()).rejects.toThrow(
      InvalidMigrationError
    );
  });

  it("rejects migration files with invalid name format", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(
      path.join(dir, "create_users_table.ts"),
      "export default { async up() {} };",
      "utf8"
    );

    await expect(new MigrationLoader({ directory: dir }).load()).rejects.toThrow(
      'Migration file "create_users_table.ts" does not match the required format'
    );
  });

  it("accepts migration files with valid YYYYMMDDHHMMSS_name format", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(
      path.join(dir, "20260112153045_create_users_table.js"),
      "export default { async up() {} };",
      "utf8"
    );

    const migrations = await new MigrationLoader({ directory: dir }).load();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.id).toBe("20260112153045_create_users_table");
  });

  it("rejects duplicate ids and invalid exports", async () => {
    const duplicateDir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(
      path.join(duplicateDir, "20260101000000_same.js"),
      "export default { async up() {} };"
    );
    await writeFile(
      path.join(duplicateDir, "20260101000000_same.ts"),
      "export default { async up() {} };"
    );
    await expect(new MigrationLoader({ directory: duplicateDir }).load()).rejects.toThrow(
      InvalidMigrationError
    );

    const invalidDir = await mkdtemp(path.join(os.tmpdir(), "chronicle-loader-"));
    await writeFile(path.join(invalidDir, "20260101000000_invalid.js"), "export default {};");
    const [migration] = await new MigrationLoader({ directory: invalidDir }).load();
    await expect(migration?.create()).rejects.toThrow(InvalidMigrationError);
  });
});
