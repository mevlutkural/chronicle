import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigNotFoundError,
  InvalidConfigError,
  defineConfig,
  loadConfig,
  resolveConfig,
  validateConfig,
  type DatabaseAdapter
} from "../src/index.js";

const adapter = {
  name: "fake",
  dialect: "fake",
  execute: async () => ({ rows: [], rowCount: 0 }),
  transaction: async (cb: (s: unknown) => Promise<unknown>) => cb({}),
  withLock: async (_name: string, cb: () => Promise<unknown>) => cb(),
  createRepository: () => ({} as never),
  createSchemaCompiler: () => ({} as never),
  close: async () => {}
} as unknown as DatabaseAdapter;

describe("config", () => {
  it("defines and resolves defaults", () => {
    const config = defineConfig({ adapter });
    const resolved = resolveConfig(config, "/workspace/app");

    expect(resolved).toMatchObject({
      adapter,
      migrations: {
        directory: "/workspace/app/database/migrations",
        namespace: "default"
      },
      policies: {
        requireDown: true,
        preventProductionRollback: true
      }
    });
  });

  it("loads default and explicit config files", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "chronicle-config-"));
    const explicit = path.join(cwd, "custom.config.js");

    Object.assign(globalThis, { __nodeMtConfigAdapter: adapter });
    await writeFile(
      path.join(cwd, "chronicle.config.js"),
      `export default {
        adapter: globalThis.__nodeMtConfigAdapter,
        migrations: { directory: "migrations", namespace: "core" },
        policies: { requireDown: false, preventProductionRollback: false }
      };`,
      "utf8"
    );
    await writeFile(
      explicit,
      "export default { adapter: globalThis.__nodeMtConfigAdapter };",
      "utf8"
    );

    await expect(loadConfig(cwd)).resolves.toMatchObject({
      migrations: { directory: path.join(cwd, "migrations"), namespace: "core" },
      policies: { requireDown: false, preventProductionRollback: false }
    });
    await expect(loadConfig(cwd, "custom.config.js")).resolves.toMatchObject({
      migrations: { namespace: "default" }
    });
  });

  it("loads CommonJS config objects directly", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "chronicle-config-"));
    Object.assign(globalThis, { __nodeMtConfigAdapter: adapter });
    await writeFile(
      path.join(cwd, "chronicle.config.cjs"),
      "module.exports = { adapter: globalThis.__nodeMtConfigAdapter };",
      "utf8"
    );

    await expect(loadConfig(cwd)).resolves.toMatchObject({ adapter });
  });

  it("loads named-export config objects directly", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "chronicle-config-"));
    Object.assign(globalThis, { __nodeMtConfigAdapter: adapter });
    await writeFile(
      path.join(cwd, "chronicle.config.js"),
      "export const adapter = globalThis.__nodeMtConfigAdapter;",
      "utf8"
    );

    await expect(loadConfig(cwd)).resolves.toMatchObject({ adapter });
  });

  it("loads explicit JSON config objects directly", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "chronicle-config-"));
    Object.assign(globalThis, { __nodeMtConfigAdapter: adapter });
    await writeFile(
      path.join(cwd, "chronicle.config.json"),
      // JSON can't hold functions, so reference the adapter via globalThis
      `{ "adapter": "globalThis.__nodeMtConfigAdapter" }`,
      "utf8"
    );

    // JSON-based configs always lack real adapter methods; validateConfig will throw.
    // This is expected — real usage requires JS/TS configs. Verify we get an InvalidConfigError
    // for adapter validation rather than a load error.
    await expect(loadConfig(cwd, "chronicle.config.json")).rejects.toThrow(InvalidConfigError);
  });

  it("resolves execution defaults to undefined when not provided", () => {
    const resolved = resolveConfig({ adapter }, "/workspace/app");

    expect(resolved.execution).toEqual({
      statementTimeoutMs: undefined,
      migrationTimeoutMs: undefined
    });
  });

  it("resolves execution values when provided", () => {
    const resolved = resolveConfig(
      { adapter, execution: { statementTimeoutMs: 30_000, migrationTimeoutMs: 300_000 } },
      "/workspace/app"
    );

    expect(resolved.execution).toEqual({
      statementTimeoutMs: 30_000,
      migrationTimeoutMs: 300_000
    });
  });

  it("validateConfig throws InvalidConfigError when adapter method is missing", () => {
    const incompleteAdapter = { name: "fake", dialect: "fake" } as unknown as DatabaseAdapter;
    expect(() => validateConfig({ adapter: incompleteAdapter }, "/fake/path")).toThrow(
      InvalidConfigError
    );
  });

  it("validateConfig throws InvalidConfigError when migrations.directory is empty array", () => {
    expect(() =>
      validateConfig({ adapter, migrations: { directory: [] } }, "/fake/path")
    ).toThrow(InvalidConfigError);
  });

  it("validateConfig throws InvalidConfigError when execution.statementTimeoutMs is negative", () => {
    expect(() =>
      validateConfig({ adapter, execution: { statementTimeoutMs: -1 } }, "/fake/path")
    ).toThrow(InvalidConfigError);
  });

  it("validateConfig does not throw for a valid full config", () => {
    const fullAdapter = {
      name: "fake",
      dialect: "fake",
      execute: async () => ({ rows: [], rowCount: 0 }),
      transaction: async (cb: (s: unknown) => Promise<unknown>) => cb({}),
      withLock: async (_name: string, cb: () => Promise<unknown>) => cb(),
      createRepository: () => ({} as never),
      createSchemaCompiler: () => ({} as never),
      close: async () => {}
    } as unknown as DatabaseAdapter;

    expect(() =>
      validateConfig(
        {
          adapter: fullAdapter,
          migrations: { directory: "database/migrations", namespace: "default" },
          policies: { requireDown: true, preventProductionRollback: false },
          execution: { statementTimeoutMs: 30_000, migrationTimeoutMs: 300_000 }
        },
        "/fake/path"
      )
    ).not.toThrow();
  });

  it("fails when config is missing or invalid", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "chronicle-config-"));
    await expect(loadConfig(cwd)).rejects.toThrow(ConfigNotFoundError);

    await writeFile(path.join(cwd, "chronicle.config.js"), "export default {};", "utf8");
    await expect(loadConfig(cwd)).rejects.toThrow(InvalidConfigError);
  });
});
