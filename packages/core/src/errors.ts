export class ChronicleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigNotFoundError extends ChronicleError {}

export class InvalidConfigError extends ChronicleError {}

export class InvalidMigrationError extends ChronicleError {}

export class MigrationDriftError extends ChronicleError {}

export class MissingDownMigrationError extends ChronicleError {}

export class ProductionRollbackBlockedError extends ChronicleError {}

export class MigrationLockTimeoutError extends ChronicleError {}

export class UnsafeSchemaCommandError extends ChronicleError {}

export class MigrationTimeoutError extends ChronicleError {
  readonly code = "MIGRATION_TIMEOUT";

  constructor(message: string) {
    super(message);
    this.name = "MigrationTimeoutError";
  }
}
