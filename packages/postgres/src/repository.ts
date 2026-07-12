import type { MigrationLogEntry, MigrationRecord, MigrationRepository } from "@chronicle/core";
import type { PostgresAdapter } from "./adapter.js";

interface MigrationRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  name: string;
  batch: number;
  checksum: string;
  checksum_algo: string;
  executed_at: Date;
  execution_ms: number;
}

export class PostgresMigrationRepository implements MigrationRepository {
  constructor(private readonly adapter: PostgresAdapter) {}

  async ensureReady(): Promise<void> {
    await this.adapter.execute(`
      CREATE TABLE IF NOT EXISTS chronicle_migrations (
        namespace text NOT NULL,
        id text NOT NULL,
        name text NOT NULL,
        batch integer NOT NULL,
        checksum text NOT NULL,
        checksum_algo text NOT NULL DEFAULT 'sha256',
        executed_at timestamptz NOT NULL DEFAULT now(),
        execution_ms integer NOT NULL,
        PRIMARY KEY (namespace, id)
      )
    `);

    await this.adapter.execute(
      `ALTER TABLE chronicle_migrations ADD COLUMN IF NOT EXISTS checksum_algo text NOT NULL DEFAULT 'sha256'`
    );

    await this.adapter.execute(`
      CREATE TABLE IF NOT EXISTS chronicle_migration_log (
        id bigserial PRIMARY KEY,
        namespace text NOT NULL,
        migration_id text NOT NULL,
        name text NOT NULL,
        direction text NOT NULL,
        status text NOT NULL,
        checksum text NOT NULL,
        batch integer,
        execution_ms integer NOT NULL,
        error text,
        environment text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        executed_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.adapter.execute(`
      CREATE INDEX IF NOT EXISTS chronicle_migrations_namespace_batch_idx
        ON chronicle_migrations (namespace, batch)
    `);

    await this.adapter.execute(`
      CREATE INDEX IF NOT EXISTS chronicle_migration_log_namespace_migration_id_idx
        ON chronicle_migration_log (namespace, migration_id)
    `);

    await this.adapter.execute(`
      CREATE INDEX IF NOT EXISTS chronicle_migration_log_executed_at_idx
        ON chronicle_migration_log (executed_at)
    `);
  }

  async listExecuted(namespace: string): Promise<readonly MigrationRecord[]> {
    try {
      const result = await this.adapter.execute<MigrationRow>({
        sql: `
          SELECT id, namespace, name, batch, checksum, checksum_algo, executed_at, execution_ms
          FROM chronicle_migrations
          WHERE namespace = $1
          ORDER BY id ASC
        `,
        bindings: [namespace]
      });

      return result.rows.map((row) => ({
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        batch: row.batch,
        checksum: row.checksum,
        checksumAlgo: row.checksum_algo ?? "sha256",
        executedAt: row.executed_at,
        executionMs: row.execution_ms
      }));
    } catch (error) {
      if (isUndefinedTable(error)) {
        return [];
      }

      throw error;
    }
  }

  async latestBatch(namespace: string): Promise<number> {
    try {
      const result = await this.adapter.execute<{ batch: number | null }>({
        sql: "SELECT max(batch) AS batch FROM chronicle_migrations WHERE namespace = $1",
        bindings: [namespace]
      });

      return result.rows[0]?.batch ?? 0;
    } catch (error) {
      if (isUndefinedTable(error)) {
        return 0;
      }

      throw error;
    }
  }

  async recordApplied(record: MigrationRecord): Promise<void> {
    await this.adapter.execute({
      sql: `
        INSERT INTO chronicle_migrations
          (namespace, id, name, batch, checksum, checksum_algo, executed_at, execution_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      bindings: [
        record.namespace,
        record.id,
        record.name,
        record.batch,
        record.checksum,
        record.checksumAlgo,
        record.executedAt,
        record.executionMs
      ]
    });
  }

  async removeApplied(namespace: string, migrationId: string): Promise<void> {
    await this.adapter.execute({
      sql: "DELETE FROM chronicle_migrations WHERE namespace = $1 AND id = $2",
      bindings: [namespace, migrationId]
    });
  }

  async recordLog(entry: MigrationLogEntry): Promise<void> {
    await this.adapter.execute({
      sql: `
        INSERT INTO chronicle_migration_log
          (namespace, migration_id, name, direction, status, checksum, batch, execution_ms, error, environment, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      bindings: [
        entry.namespace,
        entry.migrationId,
        entry.name,
        entry.direction,
        entry.status,
        entry.checksum,
        entry.batch ?? null,
        entry.executionMs,
        entry.error ?? null,
        entry.environment ?? null,
        JSON.stringify(entry.metadata ?? {})
      ]
    });
  }
}

function isUndefinedTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42P01";
}
