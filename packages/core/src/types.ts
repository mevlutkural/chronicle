import type { SchemaCommand } from "./schema.js";

export type MaybePromise<T> = T | Promise<T>;

export type MigrationDirection = "up" | "down";

export interface SqlStatement {
  readonly sql: string;
  readonly bindings?: readonly unknown[];
}

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface DatabaseSession {
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement | string
  ): Promise<QueryResult<Row>>;
}

export interface SchemaCompiler {
  compile(command: SchemaCommand): readonly SqlStatement[];
}

export interface SchemaExecutor {
  execute(commands: readonly SchemaCommand[]): Promise<readonly SqlStatement[]>;
}

export interface LockManager {
  withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T>;
}
