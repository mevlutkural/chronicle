import { existsSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { ConfigNotFoundError, InvalidConfigError } from "./errors.js";
import type { DatabaseAdapter } from "./repository.js";

export interface MigrationDiscoveryConfig {
  readonly directory: string | readonly string[];
  readonly namespace?: string;
}

export interface MigrationPolicyConfig {
  readonly requireDown?: boolean;
  readonly preventProductionRollback?: boolean;
}

export interface MigrationExecutionConfig {
  /** PostgreSQL SET statement_timeout value (ms) applied per-transaction via SET LOCAL */
  readonly statementTimeoutMs?: number;
  /** Maximum wall-clock time (ms) allowed for a single migration file to complete */
  readonly migrationTimeoutMs?: number;
}

export interface ChronicleConfig {
  readonly adapter: DatabaseAdapter;
  readonly migrations?: MigrationDiscoveryConfig;
  readonly policies?: MigrationPolicyConfig;
  readonly execution?: MigrationExecutionConfig;
}

export interface ResolvedChronicleConfig {
  readonly adapter: DatabaseAdapter;
  readonly migrations: {
    readonly directory: string | readonly string[];
    readonly namespace: string;
  };
  readonly policies: {
    readonly requireDown: boolean;
    readonly preventProductionRollback: boolean;
  };
  readonly execution: {
    readonly statementTimeoutMs: number | undefined;
    readonly migrationTimeoutMs: number | undefined;
  };
}

export function defineConfig(config: ChronicleConfig): ChronicleConfig {
  return config;
}

export function validateConfig(config: ChronicleConfig, filePath: string): void {
  const errors: string[] = [];

  if (typeof config.adapter !== "object" || config.adapter === null) {
    errors.push("adapter must be an object");
  } else {
    const adapterMethods = [
      "execute",
      "transaction",
      "withLock",
      "createRepository",
      "createSchemaCompiler",
      "close"
    ] as const;

    for (const method of adapterMethods) {
      if (typeof (config.adapter as unknown as Record<string, unknown>)[method] !== "function") {
        errors.push(`adapter.${method} must be a function`);
      }
    }
  }

  if (config.migrations?.directory !== undefined) {
    const dir = config.migrations.directory;

    if (Array.isArray(dir)) {
      if ((dir as readonly string[]).length === 0) {
        errors.push("migrations.directory must not be an empty array");
      } else {
        for (const item of dir as readonly string[]) {
          if (typeof item !== "string" || item.length === 0) {
            errors.push("migrations.directory array must contain non-empty strings");
            break;
          }
        }
      }
    } else if (typeof dir !== "string" || dir.length === 0) {
      errors.push("migrations.directory must be a non-empty string");
    }
  }

  if (config.policies !== undefined) {
    if (
      config.policies.requireDown !== undefined &&
      typeof config.policies.requireDown !== "boolean"
    ) {
      errors.push("policies.requireDown must be a boolean");
    }

    if (
      config.policies.preventProductionRollback !== undefined &&
      typeof config.policies.preventProductionRollback !== "boolean"
    ) {
      errors.push("policies.preventProductionRollback must be a boolean");
    }
  }

  if (config.execution !== undefined) {
    if (
      config.execution.statementTimeoutMs !== undefined &&
      (typeof config.execution.statementTimeoutMs !== "number" ||
        config.execution.statementTimeoutMs <= 0)
    ) {
      errors.push("execution.statementTimeoutMs must be a positive number");
    }

    if (
      config.execution.migrationTimeoutMs !== undefined &&
      (typeof config.execution.migrationTimeoutMs !== "number" ||
        config.execution.migrationTimeoutMs <= 0)
    ) {
      errors.push("execution.migrationTimeoutMs must be a positive number");
    }
  }

  if (errors.length > 0) {
    throw new InvalidConfigError(
      `Invalid chronicle configuration in ${filePath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`
    );
  }
}

export function resolveConfig(config: ChronicleConfig, cwd = process.cwd()): ResolvedChronicleConfig {
  return {
    adapter: config.adapter,
    migrations: {
      directory: Array.isArray(config.migrations?.directory)
        ? (config.migrations.directory as readonly string[]).map((d) => path.resolve(cwd, d))
        : path.resolve(cwd, (config.migrations?.directory as string | undefined) ?? "database/migrations"),
      namespace: config.migrations?.namespace ?? "default"
    },
    policies: {
      requireDown: config.policies?.requireDown ?? true,
      preventProductionRollback: config.policies?.preventProductionRollback ?? true
    },
    execution: {
      statementTimeoutMs: config.execution?.statementTimeoutMs,
      migrationTimeoutMs: config.execution?.migrationTimeoutMs
    }
  };
}

export async function loadConfig(
  cwd = process.cwd(),
  configPath?: string
): Promise<ResolvedChronicleConfig> {
  const candidates = configPath
    ? [path.resolve(cwd, configPath)]
    : [
        "chronicle.config.ts",
        "chronicle.config.mts",
        "chronicle.config.js",
        "chronicle.config.mjs",
        "chronicle.config.cjs"
      ].map((candidate) => path.resolve(cwd, candidate));

  const found = candidates.find((candidate) => existsSync(candidate));

  if (!found) {
    throw new ConfigNotFoundError(
      `Could not find a chronicle config file in ${cwd}. Expected chronicle.config.ts or chronicle.config.js.`
    );
  }

  const jiti = createJiti(import.meta.url);
  const imported: unknown = await jiti.import(found);
  const config = isConfigModule(imported) ? imported.default : imported;

  if (!isChronicleConfig(config)) {
    throw new InvalidConfigError(
      `Config file ${found} must export a chronicle configuration object.`
    );
  }

  validateConfig(config, found);

  return resolveConfig(config, cwd);
}

interface ConfigModule {
  readonly default: unknown;
}

function isConfigModule(value: unknown): value is ConfigModule {
  return typeof value === "object" && value !== null && "default" in value;
}

function isChronicleConfig(value: unknown): value is ChronicleConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "adapter" in value &&
    typeof value.adapter === "object" &&
    value.adapter !== null
  );
}
