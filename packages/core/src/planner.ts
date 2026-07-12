import { MigrationDriftError } from "./errors.js";
import type { LoadedMigration } from "./loader.js";
import type { MigrationRecord } from "./repository.js";

export type MigrationStatusKind = "pending" | "applied" | "modified" | "missing";

export interface MigrationStatus {
  readonly id: string;
  readonly name: string;
  readonly status: MigrationStatusKind;
  readonly batch?: number;
  readonly checksum?: string;
  readonly expectedChecksum?: string;
  readonly path?: string;
  readonly executedAt?: Date;
}

export class MigrationPlanner {
  constructor(
    private readonly available: readonly LoadedMigration[],
    private readonly executed: readonly MigrationRecord[]
  ) {}

  status(): readonly MigrationStatus[] {
    const availableById = new Map(this.available.map((migration) => [migration.id, migration]));
    const executedById = new Map(this.executed.map((migration) => [migration.id, migration]));
    const statuses: MigrationStatus[] = [];

    for (const migration of this.available) {
      const executed = executedById.get(migration.id);

      if (!executed) {
        statuses.push({
          id: migration.id,
          name: migration.name,
          status: "pending",
          checksum: migration.checksum,
          path: migration.path
        });
        continue;
      }

      statuses.push({
        id: migration.id,
        name: migration.name,
        status: executed.checksum === migration.checksum ? "applied" : "modified",
        batch: executed.batch,
        checksum: executed.checksum,
        expectedChecksum: migration.checksum,
        path: migration.path,
        executedAt: executed.executedAt
      });
    }

    for (const record of this.executed) {
      if (!availableById.has(record.id)) {
        statuses.push({
          id: record.id,
          name: record.name,
          status: "missing",
          batch: record.batch,
          checksum: record.checksum,
          executedAt: record.executedAt
        });
      }
    }

    return statuses.sort((a, b) => a.id.localeCompare(b.id));
  }

  pending(options: { step?: number; to?: string } = {}): readonly LoadedMigration[] {
    const executedIds = new Set(this.executed.map((migration) => migration.id));
    let pending = this.available.filter((migration) => !executedIds.has(migration.id));

    if (options.to) {
      const index = pending.findIndex((migration) => migration.id === options.to);

      if (index === -1) {
        throw new MigrationDriftError(`Target migration ${options.to} is not pending.`);
      }

      pending = pending.slice(0, index + 1);
    }

    if (options.step !== undefined) {
      pending = pending.slice(0, Math.max(0, options.step));
    }

    return pending;
  }

  rollback(options: { step?: number; to?: string } = {}): readonly MigrationRecord[] {
    if (options.to !== undefined && options.step !== undefined) {
      throw new MigrationDriftError(
        "Cannot use both --to and --step for rollback. Provide only one."
      );
    }

    const sorted = [...this.executed].sort((a, b) => b.batch - a.batch || b.id.localeCompare(a.id));

    if (options.to !== undefined) {
      const index = sorted.findIndex((migration) => migration.id === options.to);

      if (index === -1) {
        throw new MigrationDriftError(
          `Target migration ${options.to} is not in the executed list.`
        );
      }

      return sorted.slice(0, index + 1);
    }

    if (options.step !== undefined) {
      return sorted.slice(0, Math.max(0, options.step));
    }

    const latestBatch = sorted[0]?.batch;

    if (latestBatch === undefined) {
      return [];
    }

    return sorted.filter((migration) => migration.batch === latestBatch);
  }

  assertNoDrift(): void {
    const drift = this.status().filter(
      (migration) => migration.status === "modified" || migration.status === "missing"
    );

    if (drift.length > 0) {
      throw new MigrationDriftError(
        `Migration drift detected: ${drift.map((migration) => `${migration.id}:${migration.status}`).join(", ")}`
      );
    }
  }
}
