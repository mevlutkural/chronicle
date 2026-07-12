import type { EventBus, ChronicleEvent } from "./events.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface LogEntry {
  readonly level: "info" | "warn" | "error" | "debug";
  readonly message: string;
  readonly data?: Record<string, unknown>;
  readonly timestamp: string;
}

export type LogWriter = (entry: LogEntry) => void;

export interface ChronicleLoggerOptions {
  readonly level?: LogLevel;
  readonly writer?: LogWriter;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

function defaultWriter(entry: LogEntry): void {
  const data = entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : "";
  console.log(`[chronicle] ${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}${data}`);
}

export function createLogger(events: EventBus, options?: ChronicleLoggerOptions): () => void {
  const level = options?.level ?? "info";
  const writer = options?.writer ?? defaultWriter;
  const priority = LEVEL_PRIORITY[level];

  function write(entryLevel: LogEntry["level"], message: string, data?: Record<string, unknown>): void {
    if (priority === 0) return; // silent
    if (LEVEL_PRIORITY[entryLevel] > priority) return;

    const entry: LogEntry = {
      level: entryLevel,
      message,
      ...(data !== undefined ? { data } : {}),
      timestamp: new Date().toISOString()
    };

    writer(entry);
  }

  function handleEvent(event: ChronicleEvent): void {
    switch (event.type) {
      case "migration:start":
        write("info", `Running migration ${event.migrationId} (${event.direction})`);
        break;
      case "migration:success":
        write("info", `Migration ${event.migrationId} completed in ${event.executionMs}ms`);
        break;
      case "migration:failure": {
        const errorMessage =
          event.error instanceof Error ? event.error.message : String(event.error);
        write("error", `Migration ${event.migrationId} failed after ${event.executionMs}ms`, {
          error: errorMessage
        });
        break;
      }
      case "sql:statement": {
        const prefix = event.dryRun ? "[dry-run] " : "";
        write("debug", `${prefix}${event.statement.sql}`);
        break;
      }
    }
  }

  return events.on(handleEvent);
}
