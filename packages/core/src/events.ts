import type { MigrationDirection, SqlStatement } from "./types.js";

export type ChronicleEvent =
  | {
      readonly type: "migration:start";
      readonly migrationId: string;
      readonly direction: MigrationDirection;
      readonly namespace: string;
    }
  | {
      readonly type: "migration:success";
      readonly migrationId: string;
      readonly direction: MigrationDirection;
      readonly namespace: string;
      readonly executionMs: number;
    }
  | {
      readonly type: "migration:failure";
      readonly migrationId: string;
      readonly direction: MigrationDirection;
      readonly namespace: string;
      readonly executionMs: number;
      readonly error: unknown;
    }
  | {
      readonly type: "sql:statement";
      readonly migrationId: string;
      readonly direction: MigrationDirection;
      readonly namespace: string;
      readonly statement: SqlStatement;
      readonly dryRun: boolean;
    };

export type ChronicleEventHandler = (event: ChronicleEvent) => void | Promise<void>;

export class EventBus {
  readonly #handlers = new Set<ChronicleEventHandler>();

  on(handler: ChronicleEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async emit(event: ChronicleEvent): Promise<void> {
    for (const handler of this.#handlers) {
      await handler(event);
    }
  }
}
