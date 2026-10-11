import type {
  DatabaseSession,
  MigrationDirection,
  QueryResult,
  SchemaCompiler,
  SqlStatement
} from "./types.js";

export type MigrationLogStatus = "success" | "failed";

export interface MigrationRecord {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly batch: number;
  readonly checksum: string;
  readonly checksumAlgo: string;
  readonly executedAt: Date;
  readonly executionMs: number;
}

export interface MigrationLogEntry {
  readonly namespace: string;
  readonly migrationId: string;
  readonly name: string;
  readonly direction: MigrationDirection;
  readonly status: MigrationLogStatus;
  readonly checksum: string;
  readonly batch?: number | undefined;
  readonly executionMs: number;
  readonly error?: string | undefined;
  readonly environment?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MigrationRepository {
  ensureReady(): Promise<void>;
  listExecuted(namespace: string): Promise<readonly MigrationRecord[]>;
  latestBatch(namespace: string): Promise<number>;
  recordApplied(record: MigrationRecord): Promise<void>;
  removeApplied(namespace: string, migrationId: string): Promise<void>;
  recordLog(entry: MigrationLogEntry): Promise<void>;
}

export interface TransactionOptions {
  /** PostgreSQL statement timeout (ms), applied to this transaction when supported. */
  readonly statementTimeoutMs?: number;
}

export interface DatabaseAdapter {
  readonly name: string;
  readonly dialect: string;
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement | string
  ): Promise<QueryResult<Row>>;
  transaction<T>(
    callback: (session: DatabaseSession) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;
  withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T>;
  createRepository(): MigrationRepository;
  createSchemaCompiler(): SchemaCompiler;
  close(): Promise<void>;
}
