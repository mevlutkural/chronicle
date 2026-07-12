import { describe, expect, it } from "vitest";
import {
  MigrationDriftError,
  MigrationPlanner,
  type LoadedMigration,
  type MigrationRecord
} from "../src/index.js";

const loaded = (id: string, checksum = `${id}-checksum`): LoadedMigration => ({
  id,
  name: id.replace(/^\d+_/, ""),
  path: `/tmp/${id}.ts`,
  checksum,
  create: () => Promise.reject(new Error("not needed"))
});

const record = (id: string, checksum = `${id}-checksum`, batch = 1): MigrationRecord => ({
  id,
  namespace: "default",
  name: id.replace(/^\d+_/, ""),
  batch,
  checksum,
  checksumAlgo: "sha256",
  executedAt: new Date("2026-01-01T00:00:00.000Z"),
  executionMs: 1
});

describe("MigrationPlanner", () => {
  it("classifies pending and applied migrations", () => {
    const planner = new MigrationPlanner(
      [loaded("20260101000000_create_users"), loaded("20260102000000_create_posts")],
      [record("20260101000000_create_users")]
    );

    expect(planner.status().map((status) => [status.id, status.status])).toEqual([
      ["20260101000000_create_users", "applied"],
      ["20260102000000_create_posts", "pending"]
    ]);
  });

  it("detects modified and missing migrations", () => {
    const planner = new MigrationPlanner(
      [loaded("20260101000000_create_users", "new")],
      [record("20260101000000_create_users", "old"), record("20260102000000_create_posts")]
    );

    expect(planner.status().map((status) => [status.id, status.status])).toEqual([
      ["20260101000000_create_users", "modified"],
      ["20260102000000_create_posts", "missing"]
    ]);
    expect(() => planner.assertNoDrift()).toThrow(MigrationDriftError);
  });

  it("plans rollback by latest batch unless a step is given", () => {
    const planner = new MigrationPlanner(
      [],
      [
        record("20260101000000_a", "a", 1),
        record("20260102000000_b", "b", 2),
        record("20260103000000_c", "c", 2)
      ]
    );

    expect(planner.rollback().map((migration) => migration.id)).toEqual([
      "20260103000000_c",
      "20260102000000_b"
    ]);
    expect(planner.rollback({ step: 1 }).map((migration) => migration.id)).toEqual([
      "20260103000000_c"
    ]);
  });

  it("rejects unknown pending targets", () => {
    const planner = new MigrationPlanner([loaded("20260101000000_create_users")], []);

    expect(() => planner.pending({ to: "20260102000000_missing" })).toThrow(
      "Target migration 20260102000000_missing is not pending."
    );
  });

  it("rollback({ to }) rolls back including the specified migration", () => {
    const planner = new MigrationPlanner(
      [],
      [
        record("20260101000000_a", "a", 1),
        record("20260102000000_b", "b", 2),
        record("20260103000000_c", "c", 2)
      ]
    );

    // rollback to "20260102000000_b" should include c and b
    const result = planner.rollback({ to: "20260102000000_b" });
    expect(result.map((m) => m.id)).toEqual(["20260103000000_c", "20260102000000_b"]);
  });

  it("rollback({ to }) throws when the id is not in the executed list", () => {
    const planner = new MigrationPlanner([], [record("20260101000000_a", "a", 1)]);

    expect(() => planner.rollback({ to: "20260199999999_missing" })).toThrow(MigrationDriftError);
  });

  it("rollback({ to, step }) throws because they are mutually exclusive", () => {
    const planner = new MigrationPlanner([], [record("20260101000000_a", "a", 1)]);

    expect(() => planner.rollback({ to: "20260101000000_a", step: 1 })).toThrow(MigrationDriftError);
  });
});
