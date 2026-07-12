import { Migrator, resolveConfig, type ChronicleConfig } from "@chronicle/core";
import { InMemoryAdapter } from "./in-memory-adapter.js";

export interface TestMigratorOptions {
  readonly directory?: string;
  readonly adapter?: InMemoryAdapter;
  readonly namespace?: string;
}

export interface TestMigratorContext {
  readonly migrator: Migrator;
  readonly adapter: InMemoryAdapter;
}

export function createTestMigrator(options: TestMigratorOptions = {}): TestMigratorContext {
  const adapter = options.adapter ?? new InMemoryAdapter();

  const config: ChronicleConfig = {
    adapter,
    migrations: {
      directory: options.directory ?? "database/migrations",
      namespace: options.namespace ?? "test"
    },
    policies: {
      requireDown: false,
      preventProductionRollback: false
    }
  };

  const resolved = resolveConfig(config, process.cwd());
  const migrator = new Migrator(resolved);

  return { migrator, adapter };
}
