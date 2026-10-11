import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  MigrationLockTimeoutError,
  type DatabaseAdapter,
  type TransactionOptions
} from "@chronicle/core";
import { PostgresSchemaCompiler } from "./compiler.js";
import { PostgresMigrationRepository } from "./repository.js";

export interface PostgresAdapterOptions extends PoolConfig {
  readonly pool?: Pool;
  readonly lockTimeoutMs?: number;
  readonly lockPollIntervalMs?: number;
  /** PostgreSQL SET LOCAL statement_timeout value (ms) applied at the start of each transaction */
  readonly statementTimeoutMs?: number;
  /** Max connection-retry attempts for transient errors (default 3) */
  readonly retryAttempts?: number;
  /** Base delay (ms) for linear backoff between retries (default 200) */
  readonly retryBaseDelayMs?: number;
}

export function postgres(options: PostgresAdapterOptions = {}): PostgresAdapter {
  return new PostgresAdapter(options);
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly name = "chronicle-postgres";
  readonly dialect = "postgres";
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #lockTimeoutMs: number;
  readonly #lockPollIntervalMs: number;
  readonly #statementTimeoutMs: number | undefined;
  readonly #retryAttempts: number;
  readonly #retryBaseDelayMs: number;

  constructor(options: PostgresAdapterOptions = {}) {
    const {
      pool,
      lockTimeoutMs,
      lockPollIntervalMs,
      statementTimeoutMs,
      retryAttempts,
      retryBaseDelayMs,
      ...poolOptions
    } = options;

    this.#pool = pool ?? new Pool(poolOptions);
    this.#ownsPool = !pool;
    this.#lockTimeoutMs = lockTimeoutMs ?? 30_000;
    this.#lockPollIntervalMs = lockPollIntervalMs ?? 100;
    this.#statementTimeoutMs = statementTimeoutMs;
    this.#retryAttempts = retryAttempts ?? 3;
    this.#retryBaseDelayMs = retryBaseDelayMs ?? 200;
  }

  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement:
      | {
          readonly sql: string;
          readonly bindings?: readonly unknown[];
        }
      | string
  ) {
    const normalized = normalizeStatement(statement);

    return withRetry(
      async () => {
        const result = await this.#pool.query<Row>(normalized.sql, [
          ...(normalized.bindings ?? [])
        ]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
      {
        maxAttempts: this.#retryAttempts,
        baseDelayMs: this.#retryBaseDelayMs,
        retryable: isTransientPostgresError
      }
    );
  }

  async transaction<T>(
    callback: (session: PostgresSession) => Promise<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");

      // Execution-level timeout overrides the adapter default for this transaction.
      // SET LOCAL is scoped to this transaction, so it is safe for pooled connections.
      const statementTimeoutMs = options.statementTimeoutMs ?? this.#statementTimeoutMs;
      if (statementTimeoutMs !== undefined) {
        await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      }

      const result = await callback(new PostgresSession(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    const key = advisoryLockKey(lockName);
    const started = Date.now();

    // A dedicated client is checked out for the entire lock lifetime so that
    // the session-level advisory lock remains held for the full duration of the
    // callback (including all migrations). The client is released only after the
    // lock is explicitly unlocked in the finally block.
    const client = await withRetry(
      () => this.#pool.connect(),
      {
        maxAttempts: this.#retryAttempts,
        baseDelayMs: this.#retryBaseDelayMs,
        retryable: isTransientPostgresError
      }
    );

    try {
      for (;;) {
        const result = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1::bigint) AS locked",
          [key]
        );

        if (result.rows[0]?.locked) {
          break;
        }

        if (Date.now() - started >= this.#lockTimeoutMs) {
          throw new MigrationLockTimeoutError(
            `Timed out acquiring migration lock "${lockName}" after ${Date.now() - started}ms. ` +
              `Another chronicle process may be running migrations.`
          );
        }

        await delay(this.#lockPollIntervalMs);
      }

      return await callback();
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [key])
        .catch((err) => {
          /* v8 ignore next */
          console.warn(
            "[chronicle] Failed to release advisory lock:",
            err instanceof Error ? err.message : String(err)
          );
        });
      client.release();
    }
  }

  createRepository(): PostgresMigrationRepository {
    return new PostgresMigrationRepository(this);
  }

  createSchemaCompiler(): PostgresSchemaCompiler {
    return new PostgresSchemaCompiler();
  }

  async close(): Promise<void> {
    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }
}

export class PostgresSession {
  constructor(private readonly client: PoolClient) {}

  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement:
      | {
          readonly sql: string;
          readonly bindings?: readonly unknown[];
        }
      | string
  ) {
    const normalized = normalizeStatement(statement);
    const result = await this.client.query<Row>(normalized.sql, [...(normalized.bindings ?? [])]);

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0
    };
  }
}

function normalizeStatement(
  statement: { readonly sql: string; readonly bindings?: readonly unknown[] } | string
) {
  return typeof statement === "string" ? { sql: statement } : statement;
}

function advisoryLockKey(lockName: string): string {
  const hash = createHash("sha256").update(lockName).digest("hex").slice(0, 16);
  const unsigned = BigInt(`0x${hash}`);
  const maxSigned = 2n ** 63n - 1n;
  const two64 = 2n ** 64n;
  return (unsigned > maxSigned ? unsigned - two64 : unsigned).toString();
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts: number;
    baseDelayMs: number;
    retryable: (error: unknown) => boolean;
  }
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!options.retryable(error) || attempt === options.maxAttempts) {
        throw error;
      }

      lastError = error;
      await delay(options.baseDelayMs * attempt); // linear backoff
    }
  }

  throw lastError;
}

function isTransientPostgresError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  // 08* = connection errors, 57P01 = admin shutdown, 57P02 = crash shutdown, 57P03 = cannot connect now
  return (
    typeof code === "string" &&
    (code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03")
  );
}
