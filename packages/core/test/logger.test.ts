import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events.js";
import { createLogger, type LogEntry } from "../src/logger.js";

function makeEvents(): EventBus {
  return new EventBus();
}

describe("createLogger", () => {
  it("logs migration:start as info", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { writer });

    await events.emit({
      type: "migration:start",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default"
    });

    expect(writer).toHaveBeenCalledOnce();
    const entry = writer.mock.calls[0]?.[0];
    expect(entry?.level).toBe("info");
    expect(entry?.message).toContain("20260101000000_one");
    expect(entry?.message).toContain("up");
  });

  it("logs migration:success as info with executionMs", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { writer });

    await events.emit({
      type: "migration:success",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default",
      executionMs: 42
    });

    expect(writer).toHaveBeenCalledOnce();
    const entry = writer.mock.calls[0]?.[0];
    expect(entry?.level).toBe("info");
    expect(entry?.message).toContain("42ms");
  });

  it("logs migration:failure as error with error message", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { writer });

    await events.emit({
      type: "migration:failure",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default",
      executionMs: 10,
      error: new Error("something went wrong")
    });

    expect(writer).toHaveBeenCalledOnce();
    const entry = writer.mock.calls[0]?.[0];
    expect(entry?.level).toBe("error");
    expect(entry?.data?.error).toBe("something went wrong");
  });

  it("logs sql:statement as debug", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { level: "debug", writer });

    await events.emit({
      type: "sql:statement",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default",
      statement: { sql: "SELECT 1" },
      dryRun: false
    });

    expect(writer).toHaveBeenCalledOnce();
    const entry = writer.mock.calls[0]?.[0];
    expect(entry?.level).toBe("debug");
    expect(entry?.message).toContain("SELECT 1");
  });

  it("prefixes sql:statement with [dry-run] when dryRun is true", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { level: "debug", writer });

    await events.emit({
      type: "sql:statement",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default",
      statement: { sql: "CREATE TABLE t (id int)" },
      dryRun: true
    });

    const entry = writer.mock.calls[0]?.[0];
    expect(entry?.message).toContain("[dry-run]");
  });

  it("level: silent suppresses all logs", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { level: "silent", writer });

    await events.emit({
      type: "migration:start",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default"
    });

    expect(writer).not.toHaveBeenCalled();
  });

  it("level: info suppresses debug logs but not info logs", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    createLogger(events, { level: "info", writer });

    await events.emit({
      type: "sql:statement",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default",
      statement: { sql: "SELECT 1" },
      dryRun: false
    });

    await events.emit({
      type: "migration:start",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default"
    });

    expect(writer).toHaveBeenCalledOnce();
    const entry = writer.mock.calls[0]?.[0];
    expect(entry?.level).toBe("info");
  });

  it("unsubscribe stops further log calls", async () => {
    const events = makeEvents();
    const writer = vi.fn<[LogEntry], void>();
    const unsubscribe = createLogger(events, { writer });

    unsubscribe();

    await events.emit({
      type: "migration:start",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default"
    });

    expect(writer).not.toHaveBeenCalled();
  });

  it("custom writer receives a LogEntry with a timestamp", async () => {
    const events = makeEvents();
    const entries: LogEntry[] = [];
    const writer = (entry: LogEntry) => {
      entries.push(entry);
    };
    createLogger(events, { writer });

    await events.emit({
      type: "migration:success",
      migrationId: "20260101000000_one",
      direction: "up",
      namespace: "default",
      executionMs: 5
    });

    expect(entries).toHaveLength(1);
    expect(typeof entries[0]?.timestamp).toBe("string");
    expect(entries[0]?.timestamp.length).toBeGreaterThan(0);
  });
});
