import type { EventBus } from "./events.js";
import type { SchemaBuilder } from "./schema.js";
import type { DatabaseSession, MaybePromise, MigrationDirection } from "./types.js";

export interface MigrationContext {
  readonly schema: SchemaBuilder;
  readonly db: DatabaseSession;
  readonly events: EventBus;
  readonly namespace: string;
  readonly migrationId: string;
  readonly direction: MigrationDirection;
  readonly dryRun: boolean;
}

export abstract class Migration {
  readonly transaction?: boolean = true;

  abstract up(context: MigrationContext): MaybePromise<void>;

  down?(context: MigrationContext): MaybePromise<void>;
}
