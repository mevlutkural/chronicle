#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { Command } from "commander";
import {
  ConfigNotFoundError,
  Migrator,
  loadConfig,
  resolveConfig,
  type MigrationRunResult,
  type MigrationStatus,
  type ChronicleConfig,
  type ResolvedChronicleConfig,
  type SqlStatement
} from "@chronicle/core";
import { postgres } from "@chronicle/postgres";

const VERSION = "0.1.0";

interface GlobalOptions {
  readonly config?: string;
  readonly cwd: string;
  readonly format: "text" | "json";
}

export async function run(argv = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("chronicle")
    .description("Enterprise-grade TypeScript migrations for Node.js")
    .version(VERSION)
    .option("-c, --config <path>", "Path to chronicle config file")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--format <text|json>", "Output format", "text");

  program
    .command("init")
    .description("Create a chronicle config and migrations directory")
    .option("--force", "Overwrite an existing config file", false)
    .action(async (options: { force: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await initProject(globals.cwd, options.force);
    });

  program
    .command("make")
    .argument("<name>", "Migration name, for example create_users_table")
    .description("Create a timestamped migration file")
    .action(async (name: string) => {
      const globals = program.opts<GlobalOptions>();
      const config = await loadConfigOrDefault(globals.cwd, globals.config);
      const file = await makeMigration(config, name);
      console.log(chalk.green("created"), path.relative(globals.cwd, file));
      await config.adapter.close();
    });

  program
    .command("baseline")
    .description("Mark all pending migrations as applied without running SQL")
    .option("--to <id>", "Apply up to and including a specific migration id")
    .action(async (options: { to?: string }) => {
      const globals = program.opts<GlobalOptions>();
      await withMigrator(globals, async (migrator) => {
        printRunResult(await migrator.baseline(options), globals.format);
      });
    });

  program
    .command("up")
    .description("Run pending migrations")
    .option("--step <number>", "Limit the number of migrations", parsePositiveInteger)
    .option("--to <id>", "Run up to a specific pending migration id")
    .option("--dry-run", "Print SQL without mutating the database", false)
    .option("--fake", "Record migrations as applied without executing SQL", false)
    .action(async (options: { step?: number; to?: string; dryRun: boolean; fake: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await withMigrator(globals, async (migrator) => {
        printRunResult(await migrator.up(options), globals.format);
      });
    });

  program
    .command("down")
    .description("Roll back the latest batch or a fixed number of migrations")
    .option("--step <number>", "Limit the number of migrations", parsePositiveInteger)
    .option("--to <id>", "Roll back to and including a specific migration id")
    .option("--dry-run", "Print SQL without mutating the database", false)
    .option("--force", "Allow production rollback when policy blocks it", false)
    .option("--fake", "Remove migration records without executing SQL", false)
    .action(async (options: { step?: number; to?: string; dryRun: boolean; force: boolean; fake: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await withMigrator(globals, async (migrator) => {
        printRunResult(await migrator.down(options), globals.format);
      });
    });

  program
    .command("status")
    .description("Show migration status")
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      await withMigrator(globals, async (migrator) => {
        printStatus(await migrator.status(), globals.format);
      });
    });

  program
    .command("plan")
    .description("Preview pending migrations and rollback candidates")
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      await withMigrator(globals, async (migrator) => {
        const plan = await migrator.plan();
        printPlan(plan, globals.format);
      });
    });

  program
    .command("verify")
    .description("Fail if applied migrations were modified or are missing")
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      await withMigrator(globals, async (migrator) => {
        const result = await migrator.verify();
        printVerify(result, globals.format);
      });
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    console.error(chalk.red("error"), error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function withMigrator(
  options: GlobalOptions,
  callback: (migrator: Migrator) => Promise<void>
): Promise<void> {
  const cwd = options.cwd;
  const config = await loadConfig(cwd, options.config);

  try {
    await callback(new Migrator(config));
  } finally {
    await config.adapter.close();
  }
}

async function loadConfigOrDefault(
  cwd: string,
  configPath?: string
): Promise<ResolvedChronicleConfig> {
  try {
    return await loadConfig(cwd, configPath);
  } catch (error) {
    if (!(error instanceof ConfigNotFoundError)) {
      throw error;
    }

    const config: ChronicleConfig = {
      adapter: postgres(),
      migrations: {
        directory: "database/migrations",
        namespace: "default"
      }
    };

    return resolveConfig(config, cwd);
  }
}

async function initProject(cwd: string, force: boolean): Promise<void> {
  const configPath = path.resolve(cwd, "chronicle.config.ts");
  const migrationsPath = path.resolve(cwd, "database/migrations");

  if (existsSync(configPath) && !force) {
    throw new Error("chronicle.config.ts already exists. Re-run with --force to overwrite it.");
  }

  await mkdir(migrationsPath, { recursive: true });
  await writeFile(
    configPath,
    `import { defineConfig } from "@chronicle/core";
import { postgres } from "@chronicle/postgres";

export default defineConfig({
  adapter: postgres({
    connectionString: process.env.DATABASE_URL
  }),
  migrations: {
    directory: "database/migrations",
    namespace: "default"
  },
  policies: {
    requireDown: true,
    preventProductionRollback: true
  }
  // execution: {
  //   statementTimeoutMs: 30_000,
  //   migrationTimeoutMs: 300_000,
  // },
});
`,
    "utf8"
  );

  console.log(chalk.green("created"), path.relative(cwd, configPath));
  console.log(chalk.green("created"), path.relative(cwd, migrationsPath));
}

async function makeMigration(config: ResolvedChronicleConfig, name: string): Promise<string> {
  const id = `${timestamp()}_${slug(name)}`;
  const className = pascalCase(name);
  const directory = Array.isArray(config.migrations.directory)
    ? (config.migrations.directory as readonly string[])[0] ?? "database/migrations"
    : (config.migrations.directory as string);
  const file = path.resolve(directory, `${id}.ts`);

  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    `import { Migration, type MigrationContext } from "@chronicle/core";

export default class ${className} extends Migration {
  async up(_context: MigrationContext): Promise<void> {}

  async down(_context: MigrationContext): Promise<void> {}
}
`,
    "utf8"
  );

  return file;
}

function printRunResult(result: MigrationRunResult, format: "text" | "json" = "text"): void {
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          direction: result.direction,
          dryRun: result.dryRun,
          namespace: result.namespace,
          executions: result.executions.map((execution) => ({
            id: execution.id,
            name: execution.name,
            direction: execution.direction,
            batch: execution.batch,
            executionMs: execution.executionMs,
            statementCount: execution.statements.length,
            dryRun: execution.dryRun
          })),
          statements: result.statements.map((s) => ({ sql: s.sql }))
        },
        null,
        2
      )
    );
    return;
  }

  if (result.dryRun) {
    printSection(`${result.direction.toUpperCase()} dry-run`);
    printSummary("Preview", [
      ["namespace", result.namespace],
      ["migrations", String(result.executions.length)],
      ["statements", String(result.statements.length)]
    ]);
    console.log();
    printStatements(result.statements);
    return;
  }

  if (result.executions.length === 0) {
    console.log(chalk.dim(`No ${result.direction} migrations to run.`));
    return;
  }

  printSection(`${result.direction.toUpperCase()} complete`);
  printTable(
    ["direction", "migration", "batch", "statements", "time"],
    result.executions.map((execution) => [
      chalk.green(execution.direction),
      execution.id,
      execution.batch === undefined ? "-" : String(execution.batch),
      String(execution.statements.length),
      `${String(execution.executionMs)}ms`
    ])
  );
}

function printStatements(statements: readonly SqlStatement[]): void {
  if (statements.length === 0) {
    console.log(chalk.dim("No SQL statements."));
    return;
  }

  statements.forEach((statement, index) => {
    console.log(chalk.dim(`-- statement ${String(index + 1)}`));
    console.log(statement.sql);

    if (statement.bindings && statement.bindings.length > 0) {
      console.log(chalk.dim(`bindings: ${JSON.stringify(statement.bindings)}`));
    }

    if (index < statements.length - 1) {
      console.log();
    }
  });
}

function printStatus(statuses: readonly MigrationStatus[], format: "text" | "json" = "text"): void {
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          migrations: statuses.map((status) => ({
            id: status.id,
            status: status.status,
            batch: status.batch,
            checksum: status.checksum ?? null,
            executedAt: status.executedAt ? status.executedAt.toISOString() : null
          }))
        },
        null,
        2
      )
    );
    return;
  }

  if (statuses.length === 0) {
    console.log(chalk.dim("No migrations found."));
    return;
  }

  const rows = statuses.map((status) => [
    status.id,
    colorStatus(status.status),
    status.batch === undefined ? "-" : String(status.batch),
    status.checksum ? shortHash(status.checksum) : "-",
    status.executedAt ? status.executedAt.toISOString() : "-"
  ]);

  printTable(["migration", "status", "batch", "checksum", "executed_at"], rows);
}

function printPlan(
  plan: {
    readonly status: readonly MigrationStatus[];
    readonly pending: readonly { readonly id: string; readonly checksum: string }[];
    readonly rollback: readonly { readonly id: string; readonly batch: number }[];
  },
  format: "text" | "json" = "text"
): void {
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          statuses: plan.status.map((status) => ({
            id: status.id,
            status: status.status,
            batch: status.batch,
            checksum: status.checksum ?? null,
            executedAt: status.executedAt ? status.executedAt.toISOString() : null
          })),
          pending: plan.pending.map((m) => ({ id: m.id, checksum: m.checksum })),
          rollback: plan.rollback.map((m) => ({ id: m.id, batch: m.batch }))
        },
        null,
        2
      )
    );
    return;
  }

  printStatus(plan.status, "text");
  console.log();
  printSummary("Plan summary", [
    ["pending", String(plan.pending.length)],
    ["rollback candidates", String(plan.rollback.length)]
  ]);

  if (plan.pending.length > 0) {
    console.log();
    printTable(
      ["pending migration", "checksum"],
      plan.pending.map((migration) => [migration.id, shortHash(migration.checksum)])
    );
  }

  if (plan.rollback.length > 0) {
    console.log();
    printTable(
      ["rollback candidate", "batch"],
      plan.rollback.map((migration) => [migration.id, String(migration.batch)])
    );
  }
}

function printVerify(
  result: { readonly ok: boolean; readonly statuses: readonly MigrationStatus[] },
  format: "text" | "json" = "text"
): void {
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          migrations: result.statuses.map((status) => ({
            id: status.id,
            status: status.status,
            batch: status.batch,
            checksum: status.checksum ?? null,
            executedAt: status.executedAt ? status.executedAt.toISOString() : null
          }))
        },
        null,
        2
      )
    );

    if (!result.ok) {
      process.exitCode = 1;
    }

    return;
  }

  printStatus(result.statuses, "text");

  if (!result.ok) {
    console.log();
    console.log(chalk.red("Verification failed. Modified or missing migrations were detected."));
    process.exitCode = 1;
  } else {
    console.log();
    console.log(chalk.green("Verification passed. Migration history is consistent."));
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }

  return parsed;
}

function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function slug(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pascalCase(value: string): string {
  return slug(value)
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function printSection(title: string): void {
  console.log(chalk.bold(title));
}

function printSummary(title: string, rows: readonly (readonly [string, string])[]): void {
  printSection(title);
  const width = Math.max(...rows.map(([label]) => label.length));

  for (const [label, value] of rows) {
    console.log(`${chalk.dim(label.padEnd(width))}  ${value}`);
  }
}

function printTable(headings: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => stripAnsi(tableCell(row, index)).length))
  );

  console.log(
    headings
      .map((heading, index) =>
        chalk.bold(heading.padEnd(tableWidth(widths, index, heading.length)))
      )
      .join("  ")
  );
  console.log(widths.map((width) => "-".repeat(width)).join("  "));

  for (const row of rows) {
    console.log(
      row.map((cell, index) => padAnsi(cell, tableWidth(widths, index, cell.length))).join("  ")
    );
  }
}

function colorStatus(status: MigrationStatus["status"]): string {
  switch (status) {
    case "applied":
      return chalk.green(status);
    case "pending":
      return chalk.yellow(status);
    case "modified":
    case "missing":
      return chalk.red(status);
  }
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function padAnsi(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
}

function stripAnsi(value: string): string {
  return value.replace(ansiPattern(), "");
}

function tableCell(row: readonly string[], index: number): string {
  /* v8 ignore next */
  return row[index] ?? "";
}

function tableWidth(widths: readonly number[], index: number, fallback: number): number {
  /* v8 ignore next */
  return widths[index] ?? fallback;
}

function ansiPattern(): RegExp {
  return new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
}

/* v8 ignore next 3 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
