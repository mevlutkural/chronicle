import type {
  DatabaseAdapter,
  DatabaseSession,
  MigrationLogEntry,
  MigrationRecord,
  MigrationRepository,
  QueryResult,
  SchemaCommand,
  SchemaCompiler,
  SqlStatement
} from "@chronicle/core";

export interface InMemoryAdapterOptions {
  readonly dialect?: string;
}

class InMemoryStore {
  readonly migrations = new Map<string, MigrationRecord>(); // key: `${namespace}:${id}`
  readonly logs: MigrationLogEntry[] = [];
}

class InMemoryRepository implements MigrationRepository {
  constructor(private readonly store: InMemoryStore) {}

  async ensureReady(): Promise<void> {}

  async listExecuted(namespace: string): Promise<readonly MigrationRecord[]> {
    return [...this.store.migrations.values()]
      .filter((r) => r.namespace === namespace)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async latestBatch(namespace: string): Promise<number> {
    const records = await this.listExecuted(namespace);
    return records.reduce((max, r) => Math.max(max, r.batch), 0);
  }

  async recordApplied(record: MigrationRecord): Promise<void> {
    this.store.migrations.set(`${record.namespace}:${record.id}`, record);
  }

  async removeApplied(namespace: string, migrationId: string): Promise<void> {
    this.store.migrations.delete(`${namespace}:${migrationId}`);
  }

  async recordLog(entry: MigrationLogEntry): Promise<void> {
    this.store.logs.push(entry);
  }
}

class InMemorySchemaCompiler implements SchemaCompiler {
  compile(command: SchemaCommand): readonly SqlStatement[] {
    switch (command.kind) {
      case "createTable":
        return [{ sql: `-- createTable: ${command.tableName}` }];
      case "dropTable":
        return [{ sql: `-- dropTable: ${command.tableName}` }];
      case "alterTable":
        return [{ sql: `-- alterTable: ${command.tableName}` }];
      case "createEnum":
        return [{ sql: `-- createEnum: ${command.enumName}` }];
      case "dropEnum":
        return [{ sql: `-- dropEnum: ${command.enumName}` }];
      case "renameTable":
        return [{ sql: `-- renameTable: ${command.from} -> ${command.to}` }];
      case "truncateTable":
        return [{ sql: `-- truncateTable: ${command.tableName}` }];
      case "raw":
        return command.statements;
    }
  }
}

export class InMemoryAdapter implements DatabaseAdapter {
  readonly name = "chronicle-memory";
  readonly dialect: string;

  readonly executedStatements: SqlStatement[] = [];

  #responseQueue: Array<QueryResult> = [];
  readonly #store = new InMemoryStore();

  constructor(options: InMemoryAdapterOptions = {}) {
    this.dialect = options.dialect ?? "memory";
  }

  queueResponse(result: QueryResult): this {
    this.#responseQueue.push(result);
    return this;
  }

  async execute<Row extends Record<string, unknown>>(
    statement: SqlStatement | string
  ): Promise<QueryResult<Row>> {
    const normalized = typeof statement === "string" ? { sql: statement } : statement;
    this.executedStatements.push(normalized);
    const queued = this.#responseQueue.shift();
    return (queued ?? { rows: [], rowCount: 0 }) as QueryResult<Row>;
  }

  async transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async withLock<T>(_lockName: string, callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  createRepository(): MigrationRepository {
    return new InMemoryRepository(this.#store);
  }

  createSchemaCompiler(): SchemaCompiler {
    return new InMemorySchemaCompiler();
  }

  async close(): Promise<void> {}

  clearStatements(): void {
    this.executedStatements.length = 0;
  }
}
