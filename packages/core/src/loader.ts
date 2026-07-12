import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";
import { InvalidMigrationError } from "./errors.js";
import type { Migration } from "./migration.js";

export interface LoadedMigration {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly checksum: string;
  create(): Promise<Migration>;
}

export interface MigrationLoaderOptions {
  readonly directory: string | readonly string[];
}

const MIGRATION_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);

const MIGRATION_FILENAME_REGEX = /^\d{14}[_-][a-z][a-z0-9_]*$/;

export class MigrationLoader {
  constructor(private readonly options: MigrationLoaderOptions) {}

  async load(): Promise<readonly LoadedMigration[]> {
    const directories = Array.isArray(this.options.directory)
      ? (this.options.directory as readonly string[])
      : [this.options.directory as string];

    const allFiles: string[] = [];

    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && MIGRATION_EXTENSIONS.has(path.extname(entry.name)))
        .map((entry) => path.resolve(directory, entry.name));

      allFiles.push(...files);
    }

    // Sort globally by basename (filename) so ordering is consistent across directories
    allFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

    // Validate filenames before loading
    for (const file of allFiles) {
      const basename = path.basename(file, path.extname(file));
      if (!MIGRATION_FILENAME_REGEX.test(basename)) {
        throw new InvalidMigrationError(
          `Migration file "${path.basename(file)}" does not match the required format: YYYYMMDDHHMMSS_name (e.g. 20260112153045_create_users_table)`
        );
      }
    }

    const migrations = await Promise.all(allFiles.map((file) => this.#loadFile(file)));
    const ids = new Set<string>();

    for (const migration of migrations) {
      if (ids.has(migration.id)) {
        throw new InvalidMigrationError(`Duplicate migration id detected: ${migration.id}`);
      }

      ids.add(migration.id);
    }

    return migrations;
  }

  async #loadFile(file: string): Promise<LoadedMigration> {
    const contents = await readFile(file, "utf8");
    const id = path.basename(file, path.extname(file));
    const name = id.replace(/^\d{14}[_-]?/, "");
    const checksum = createHash("sha256").update(normalize(contents)).digest("hex");

    return {
      id,
      name,
      path: file,
      checksum,
      create: async () => instantiateMigration(file)
    };
  }
}

export function normalizeMigrationSource(source: string): string {
  return normalize(source);
}

async function instantiateMigration(file: string): Promise<Migration> {
  const jiti = createJiti(import.meta.url);
  const imported: unknown = await jiti.import(file);
  const exported = isModuleWithDefault(imported) ? imported.default : imported;
  const instance =
    typeof exported === "function" ? new (exported as new () => Migration)() : exported;

  if (!isMigration(instance)) {
    throw new InvalidMigrationError(
      `Migration ${file} must default export a Migration instance or class with an up() method.`
    );
  }

  return instance;
}

function isMigration(value: unknown): value is Migration {
  return (
    typeof value === "object" && value !== null && "up" in value && typeof value.up === "function"
  );
}

function isModuleWithDefault(value: unknown): value is { readonly default: unknown } {
  return typeof value === "object" && value !== null && "default" in value;
}

function normalize(source: string): string {
  return source.replace(/\r\n/g, "\n").trimEnd();
}
