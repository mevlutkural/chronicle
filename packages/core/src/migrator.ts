import { EventBus } from "./events.js";
import {
  MissingDownMigrationError,
  ProductionRollbackBlockedError,
  UnsafeSchemaCommandError,
  MigrationDriftError,
  MigrationTimeoutError
} from "./errors.js";
import { MigrationLoader, type LoadedMigration } from "./loader.js";
import type { Migration, MigrationContext } from "./migration.js";
import { MigrationPlanner, type MigrationStatus } from "./planner.js";
import type { MigrationLogEntry, MigrationRecord, MigrationRepository } from "./repository.js";
import { SchemaBuilder, type SchemaCommand } from "./schema.js";
import type { DatabaseSession, MigrationDirection, SchemaCompiler, SqlStatement } from "./types.js";
import type { ResolvedChronicleConfig } from "./config.js";

export interface MigrationRunOptions {
  readonly step?: number;
  readonly to?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly fake?: boolean;
  readonly environment?: string;
}

export interface MigrationExecution {
  readonly id: string;
  readonly name: string;
  readonly direction: MigrationDirection;
  readonly checksum: string;
  readonly batch?: number | undefined;
  readonly executionMs: number;
  readonly statements: readonly SqlStatement[];
  readonly dryRun: boolean;
}

export interface MigrationRunResult {
  readonly direction: MigrationDirection;
  readonly dryRun: boolean;
  readonly namespace: string;
  readonly executions: readonly MigrationExecution[];
  readonly statements: readonly SqlStatement[];
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly statuses: readonly MigrationStatus[];
}

export class Migrator {
  readonly #events: EventBus;

  constructor(
    private readonly config: ResolvedChronicleConfig,
    events = new EventBus()
  ) {
    this.#events = events;
  }

  get events(): EventBus {
    return this.#events;
  }

  async status(): Promise<readonly MigrationStatus[]> {
    const { repository, loaded, executed } = await this.#readState({ ensureReady: false });
    void repository;
    return new MigrationPlanner(loaded, executed).status();
  }

  async plan(): Promise<{
    readonly status: readonly MigrationStatus[];
    readonly pending: readonly LoadedMigration[];
    readonly rollback: readonly MigrationRecord[];
  }> {
    const { repository, loaded, executed } = await this.#readState({ ensureReady: false });
    void repository;
    const planner = new MigrationPlanner(loaded, executed);

    return {
      status: planner.status(),
      pending: planner.pending(),
      rollback: planner.rollback()
    };
  }

  async verify(): Promise<VerificationResult> {
    const statuses = await this.status();
    const ok = statuses.every(
      (migration) => migration.status !== "modified" && migration.status !== "missing"
    );

    return { ok, statuses };
  }

  async baseline(options: { to?: string; environment?: string } = {}): Promise<MigrationRunResult> {
    // NOTE: `run` is passed to `withLock` below, so `ensureReady` runs after the advisory lock
    // is acquired — which is the correct order for baseline as well.
    const run = async (): Promise<MigrationRunResult> => {
      const { repository, loaded, executed } = await this.#readState({ ensureReady: true });
      const planner = new MigrationPlanner(loaded, executed);
      const batch = (await repository.latestBatch(this.config.migrations.namespace)) + 1;
      const executions: MigrationExecution[] = [];

      const baselinePendingOptions: { to?: string } = {};
      if (options.to !== undefined) {
        baselinePendingOptions.to = options.to;
      }

      for (const loadedMigration of planner.pending(baselinePendingOptions)) {
        const started = Date.now();

        await this.#events.emit({
          type: "migration:start",
          migrationId: loadedMigration.id,
          direction: "up",
          namespace: this.config.migrations.namespace
        });

        await repository.recordApplied({
          id: loadedMigration.id,
          namespace: this.config.migrations.namespace,
          name: loadedMigration.name,
          batch,
          checksum: loadedMigration.checksum,
          checksumAlgo: "sha256",
          executedAt: new Date(),
          executionMs: 0
        });

        const executionMs = Date.now() - started;

        await repository.recordLog(
          this.#logEntry({
            loadedMigration,
            direction: "up",
            status: "success",
            executionMs,
            batch,
            environment: options.environment
          })
        );

        await this.#events.emit({
          type: "migration:success",
          migrationId: loadedMigration.id,
          direction: "up",
          namespace: this.config.migrations.namespace,
          executionMs
        });

        executions.push({
          id: loadedMigration.id,
          name: loadedMigration.name,
          direction: "up",
          checksum: loadedMigration.checksum,
          batch,
          executionMs,
          statements: [],
          dryRun: false
        });
      }

      return {
        direction: "up",
        dryRun: false,
        namespace: this.config.migrations.namespace,
        executions,
        statements: []
      };
    };

    return this.config.adapter.withLock(`chronicle:${this.config.migrations.namespace}`, run);
  }

  async up(options: MigrationRunOptions = {}): Promise<MigrationRunResult> {
    return this.#run("up", options);
  }

  async down(options: MigrationRunOptions = {}): Promise<MigrationRunResult> {
    if (
      this.config.policies.preventProductionRollback &&
      !options.force &&
      (options.environment ?? process.env.NODE_ENV) === "production"
    ) {
      throw new ProductionRollbackBlockedError(
        "Rollback is blocked in production. Pass force: true only after an explicit operational approval."
      );
    }

    return this.#run("down", options);
  }

  async #run(
    direction: MigrationDirection,
    options: MigrationRunOptions
  ): Promise<MigrationRunResult> {
    const dryRun = options.dryRun ?? false;
    const fake = options.fake ?? false;

    if (fake && dryRun) {
      throw new MigrationDriftError("Cannot use both fake and dryRun options at the same time.");
    }

    // NOTE: `run` is always executed inside `withLock` (see bottom of this method), so
    // `#readState({ ensureReady: true })` — and therefore `repository.ensureReady()` — runs
    // after the advisory lock is acquired. This is the correct order.
    const run = async (): Promise<MigrationRunResult> => {
      const { repository, loaded, executed } = await this.#readState({ ensureReady: !dryRun });
      const planner = new MigrationPlanner(loaded, executed);
      planner.assertNoDrift();

      const loadedById = new Map(loaded.map((migration) => [migration.id, migration]));
      const batch =
        direction === "up"
          ? (await repository.latestBatch(this.config.migrations.namespace)) + 1
          : undefined;
      const executions: MigrationExecution[] = [];

      if (direction === "up") {
        const pendingOptions: { step?: number; to?: string } = {};

        if (options.step !== undefined) {
          pendingOptions.step = options.step;
        }

        if (options.to !== undefined) {
          pendingOptions.to = options.to;
        }

        for (const loadedMigration of planner.pending(pendingOptions)) {
          const execution = await this.#executeMigration({
            repository,
            loadedMigration,
            direction,
            dryRun,
            fake,
            batch,
            environment: options.environment
          });

          executions.push(execution);
        }
      } else {
        const rollbackOptions: { step?: number; to?: string } = {};

        if (options.step !== undefined) {
          rollbackOptions.step = options.step;
        }

        if (options.to !== undefined) {
          rollbackOptions.to = options.to;
        }

        for (const target of planner.rollback(rollbackOptions)) {
          const loadedMigration = loadedById.get(target.id);

          /* v8 ignore next 3 */
          if (!loadedMigration) {
            failMissingLoadedMigration(target.id);
          }

          const execution = await this.#executeMigration({
            repository,
            loadedMigration,
            direction,
            dryRun,
            fake,
            batch: target.batch,
            environment: options.environment
          });

          executions.push(execution);
        }
      }

      return {
        direction,
        dryRun,
        namespace: this.config.migrations.namespace,
        executions,
        statements: executions.flatMap((execution) => execution.statements)
      };
    };

    if (dryRun) {
      return run();
    }

    return this.config.adapter.withLock(`chronicle:${this.config.migrations.namespace}`, run);
  }

  async #readState(options: { ensureReady: boolean }): Promise<{
    readonly repository: MigrationRepository;
    readonly loaded: readonly LoadedMigration[];
    readonly executed: readonly MigrationRecord[];
  }> {
    const repository = this.config.adapter.createRepository();
    if (options.ensureReady) {
      await repository.ensureReady();
    }

    const loader = new MigrationLoader({ directory: this.config.migrations.directory });
    const loaded = await loader.load();
    const executed = await repository.listExecuted(this.config.migrations.namespace);

    return { repository, loaded, executed };
  }

  async #executeMigration(input: {
    readonly repository: MigrationRepository;
    readonly loadedMigration: LoadedMigration;
    readonly direction: MigrationDirection;
    readonly dryRun: boolean;
    readonly fake: boolean;
    readonly batch?: number | undefined;
    readonly environment?: string | undefined;
  }): Promise<MigrationExecution> {
    const statements: SqlStatement[] = [];
    const started = Date.now();

    await this.#events.emit({
      type: "migration:start",
      migrationId: input.loadedMigration.id,
      direction: input.direction,
      namespace: this.config.migrations.namespace
    });

    try {
      if (input.fake) {
        // fake mode: skip SQL execution, only update metadata
        const executionMs = Date.now() - started;

        if (input.direction === "up") {
          await input.repository.recordApplied({
            id: input.loadedMigration.id,
            namespace: this.config.migrations.namespace,
            name: input.loadedMigration.name,
            batch: requiredAppliedBatch(input.batch),
            checksum: input.loadedMigration.checksum,
            checksumAlgo: "sha256",
            executedAt: new Date(),
            executionMs
          });
        } else {
          await input.repository.removeApplied(
            this.config.migrations.namespace,
            input.loadedMigration.id
          );
        }

        await input.repository.recordLog(
          this.#logEntry({
            loadedMigration: input.loadedMigration,
            direction: input.direction,
            status: "success",
            executionMs,
            batch: input.batch,
            environment: input.environment
          })
        );

        await this.#events.emit({
          type: "migration:success",
          migrationId: input.loadedMigration.id,
          direction: input.direction,
          namespace: this.config.migrations.namespace,
          executionMs
        });

        return {
          id: input.loadedMigration.id,
          name: input.loadedMigration.name,
          direction: input.direction,
          checksum: input.loadedMigration.checksum,
          batch: input.batch,
          executionMs,
          statements: [],
          dryRun: false
        };
      }

      const migration = await input.loadedMigration.create();

      if (
        input.direction === "down" &&
        this.config.policies.requireDown &&
        typeof migration.down !== "function"
      ) {
        throw new MissingDownMigrationError(
          `Migration ${input.loadedMigration.id} does not define down().`
        );
      }

      await this.#invokeMigration(migration, {
        loadedMigration: input.loadedMigration,
        direction: input.direction,
        dryRun: input.dryRun,
        statements
      });

      const executionMs = Date.now() - started;

      if (!input.dryRun) {
        if (input.direction === "up") {
          await input.repository.recordApplied({
            id: input.loadedMigration.id,
            namespace: this.config.migrations.namespace,
            name: input.loadedMigration.name,
            batch: requiredAppliedBatch(input.batch),
            checksum: input.loadedMigration.checksum,
            checksumAlgo: "sha256",
            executedAt: new Date(),
            executionMs
          });
        } else {
          await input.repository.removeApplied(
            this.config.migrations.namespace,
            input.loadedMigration.id
          );
        }

        await input.repository.recordLog(
          this.#logEntry({
            loadedMigration: input.loadedMigration,
            direction: input.direction,
            status: "success",
            executionMs,
            batch: input.batch,
            environment: input.environment
          })
        );
      }

      await this.#events.emit({
        type: "migration:success",
        migrationId: input.loadedMigration.id,
        direction: input.direction,
        namespace: this.config.migrations.namespace,
        executionMs
      });

      return {
        id: input.loadedMigration.id,
        name: input.loadedMigration.name,
        direction: input.direction,
        checksum: input.loadedMigration.checksum,
        batch: input.batch,
        executionMs,
        statements,
        dryRun: input.dryRun
      };
    } catch (error) {
      const executionMs = Date.now() - started;

      if (!input.dryRun) {
        await input.repository.recordLog(
          this.#logEntry({
            loadedMigration: input.loadedMigration,
            direction: input.direction,
            status: "failed",
            executionMs,
            batch: input.batch,
            environment: input.environment,
            error
          })
        );
      }

      await this.#events.emit({
        type: "migration:failure",
        migrationId: input.loadedMigration.id,
        direction: input.direction,
        namespace: this.config.migrations.namespace,
        executionMs,
        error
      });

      throw error;
    }
  }

  async #invokeMigration(
    migration: Migration,
    input: {
      readonly loadedMigration: LoadedMigration;
      readonly direction: MigrationDirection;
      readonly dryRun: boolean;
      readonly statements: SqlStatement[];
    }
  ): Promise<void> {
    const useTransaction = migration.transaction !== false;
    const callback = async (session: DatabaseSession): Promise<void> => {
      const schema = new SchemaBuilder({
        execute: async (commands) =>
          this.#executeSchemaCommands({
            commands,
            compiler: this.config.adapter.createSchemaCompiler(),
            session,
            dryRun: input.dryRun,
            transactional: !input.dryRun && useTransaction,
            statements: input.statements,
            loadedMigration: input.loadedMigration,
            direction: input.direction
          })
      });
      const dryRunSession = new DryRunSession(input.statements, this.#events, {
        namespace: this.config.migrations.namespace,
        migrationId: input.loadedMigration.id,
        direction: input.direction,
        dryRun: input.dryRun
      });
      const context: MigrationContext = {
        schema,
        db: input.dryRun ? dryRunSession : session,
        events: this.#events,
        namespace: this.config.migrations.namespace,
        migrationId: input.loadedMigration.id,
        direction: input.direction,
        dryRun: input.dryRun
      };

      if (input.direction === "up") {
        await migration.up(context);
      } else if (typeof migration.down === "function") {
        await migration.down(context);
      }
    };

    const statementTimeoutMs = this.config.execution.statementTimeoutMs;
    const migrationPromise = input.dryRun || !useTransaction
      ? callback(this.config.adapter)
      : this.config.adapter.transaction(
          callback,
          statementTimeoutMs === undefined ? {} : { statementTimeoutMs }
        );

    if (this.config.execution.migrationTimeoutMs !== undefined) {
      const timeout = this.config.execution.migrationTimeoutMs;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new MigrationTimeoutError(
                `Migration ${input.loadedMigration.id} timed out after ${timeout}ms`
              )
            ),
          timeout
        )
      );
      await Promise.race([migrationPromise, timeoutPromise]);
    } else {
      await migrationPromise;
    }
  }

  async #executeSchemaCommands(input: {
    readonly commands: readonly SchemaCommand[];
    readonly compiler: SchemaCompiler;
    readonly session: DatabaseSession;
    readonly dryRun: boolean;
    readonly transactional: boolean;
    readonly statements: SqlStatement[];
    readonly loadedMigration: LoadedMigration;
    readonly direction: MigrationDirection;
  }): Promise<readonly SqlStatement[]> {
    if (input.transactional && hasConcurrentIndex(input.commands)) {
      throw new UnsafeSchemaCommandError(
        "CREATE INDEX CONCURRENTLY cannot run inside a transaction. Set `readonly transaction = false` on this migration."
      );
    }

    const statements = input.commands.flatMap((command) => [...input.compiler.compile(command)]);

    for (const statement of statements) {
      input.statements.push(statement);
      await this.#events.emit({
        type: "sql:statement",
        migrationId: input.loadedMigration.id,
        direction: input.direction,
        namespace: this.config.migrations.namespace,
        statement,
        dryRun: input.dryRun
      });

      if (!input.dryRun) {
        await input.session.execute(statement);
      }
    }

    return statements;
  }

  #logEntry(input: {
    readonly loadedMigration: LoadedMigration;
    readonly direction: MigrationDirection;
    readonly status: MigrationLogEntry["status"];
    readonly executionMs: number;
    readonly batch?: number | undefined;
    readonly environment?: string | undefined;
    readonly error?: unknown;
  }): MigrationLogEntry {
    return {
      namespace: this.config.migrations.namespace,
      migrationId: input.loadedMigration.id,
      name: input.loadedMigration.name,
      direction: input.direction,
      status: input.status,
      checksum: input.loadedMigration.checksum,
      batch: input.batch,
      executionMs: input.executionMs,
      error: input.error instanceof Error ? input.error.message : undefined,
      environment: input.environment,
      metadata: {
        adapter: this.config.adapter.name
      }
    };
  }
}

class DryRunSession implements DatabaseSession {
  constructor(
    private readonly statements: SqlStatement[],
    private readonly events: EventBus,
    private readonly eventContext: {
      readonly namespace: string;
      readonly migrationId: string;
      readonly direction: MigrationDirection;
      readonly dryRun: boolean;
    }
  ) {}

  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement | string
  ) {
    const normalized = typeof statement === "string" ? { sql: statement } : statement;
    this.statements.push(normalized);
    await this.events.emit({
      type: "sql:statement",
      statement: normalized,
      ...this.eventContext
    });

    return { rows: [] as Row[], rowCount: 0 };
  }
}

function hasConcurrentIndex(commands: readonly SchemaCommand[]): boolean {
  return commands.some((command) => {
    if (command.kind === "createTable") {
      return command.indexes.some((index) => index.concurrently);
    }

    if (command.kind === "alterTable") {
      return command.operations.some(
        (operation) => operation.kind === "addIndex" && operation.index.concurrently
      );
    }

    return false;
  });
}

/* v8 ignore next 5 */
function failMissingLoadedMigration(migrationId: string): never {
  throw new MissingDownMigrationError(
    `Cannot roll back ${migrationId}; its migration file is missing.`
  );
}

function requiredAppliedBatch(batch: number | undefined): number {
  /* v8 ignore next 3 */
  if (batch === undefined) {
    throw new Error("Applied migrations must have a batch number.");
  }

  return batch;
}
