import type { SchemaExecutor, SqlStatement } from "./types.js";

export type ColumnType =
  | "uuid"
  | "string"
  | "text"
  | "enum"
  | "integer"
  | "bigInteger"
  | "boolean"
  | "timestamp"
  | "date"
  | "decimal"
  | "json"
  | "jsonb";

export interface ColumnOptions {
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly withTimezone?: boolean;
  readonly enumName?: string;
  readonly enumValues?: readonly string[];
  readonly useExistingEnum?: boolean;
}

export interface ForeignKeyDefinition {
  readonly table: string;
  readonly column: string;
  readonly onDelete?: "cascade" | "restrict" | "set null" | "no action";
  readonly onUpdate?: "cascade" | "restrict" | "set null" | "no action";
}

export interface TableForeignKeyDefinition {
  readonly constraintName?: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onDelete?: ForeignKeyDefinition["onDelete"];
  readonly onUpdate?: ForeignKeyDefinition["onUpdate"];
}

export interface CheckConstraintDefinition {
  readonly constraintName: string;
  readonly expression: string;
}

export interface CompositePrimaryKeyDefinition {
  readonly columns: readonly string[];
  readonly constraintName?: string;
}

export interface TableUniqueConstraint {
  readonly columns: readonly string[];
  readonly constraintName?: string;
}

export interface ColumnDefinition {
  readonly name: string;
  readonly type: ColumnType;
  readonly options: ColumnOptions;
  readonly nullable: boolean;
  readonly primary: boolean;
  readonly unique: boolean;
  readonly defaultValue?: unknown;
  readonly defaultExpression?: string;
  readonly foreignKey?: ForeignKeyDefinition;
}

export interface IndexDefinition {
  readonly columns: readonly string[];
  readonly name?: string;
  readonly unique: boolean;
  readonly concurrently: boolean;
  readonly method?: "btree" | "hash" | "gist" | "gin" | "brin";
  readonly where?: string;
  readonly ifNotExists: boolean;
}

export interface IndexOptions {
  readonly name?: string;
  readonly concurrently?: boolean;
  readonly method?: IndexDefinition["method"];
  readonly where?: string;
  readonly ifNotExists?: boolean;
}

export interface EnumColumnOptions extends ColumnOptions {
  readonly enumName?: string;
  readonly values?: readonly string[];
  readonly useExisting?: boolean;
}

export interface AuditUserColumnOptions extends ColumnOptions {
  readonly type?: "uuid" | "integer" | "bigInteger";
  readonly nullable?: boolean;
  readonly references?: {
    readonly table?: string;
    readonly column?: string;
    readonly onDelete?: ForeignKeyDefinition["onDelete"];
    readonly onUpdate?: ForeignKeyDefinition["onUpdate"];
  };
}

export interface CreateTableCommand {
  readonly kind: "createTable";
  readonly tableName: string;
  readonly columns: readonly ColumnDefinition[];
  readonly indexes: readonly IndexDefinition[];
  readonly primaryKey?: CompositePrimaryKeyDefinition;
  readonly checks: readonly CheckConstraintDefinition[];
  readonly uniqueConstraints: readonly TableUniqueConstraint[];
  readonly ifNotExists: boolean;
}

export interface DropTableCommand {
  readonly kind: "dropTable";
  readonly tableName: string;
  readonly ifExists: boolean;
  readonly cascade: boolean;
}

export interface CreateEnumCommand {
  readonly kind: "createEnum";
  readonly enumName: string;
  readonly values: readonly string[];
  readonly ifNotExists: boolean;
}

export interface DropEnumCommand {
  readonly kind: "dropEnum";
  readonly enumName: string;
  readonly ifExists: boolean;
  readonly cascade: boolean;
}

export type AlterTableOperation =
  | { readonly kind: "addColumn"; readonly column: ColumnDefinition }
  | { readonly kind: "dropColumn"; readonly columnName: string; readonly ifExists: boolean }
  | { readonly kind: "renameColumn"; readonly from: string; readonly to: string }
  | { readonly kind: "addIndex"; readonly index: IndexDefinition }
  | { readonly kind: "addForeignKey"; readonly foreignKey: TableForeignKeyDefinition }
  | { readonly kind: "dropForeignKey"; readonly constraintName: string }
  | { readonly kind: "changeType"; readonly columnName: string; readonly newType: ColumnType; readonly newOptions: ColumnOptions; readonly using?: string }
  | { readonly kind: "setNullable"; readonly columnName: string; readonly nullable: boolean }
  | { readonly kind: "setDefault"; readonly columnName: string; readonly value: unknown }
  | { readonly kind: "dropDefault"; readonly columnName: string }
  | { readonly kind: "dropIndex"; readonly indexName: string }
  | { readonly kind: "renameIndex"; readonly from: string; readonly to: string }
  | { readonly kind: "addPrimaryKey"; readonly columns: readonly string[]; readonly constraintName?: string }
  | { readonly kind: "dropPrimaryKey"; readonly constraintName: string }
  | { readonly kind: "addCheck"; readonly check: CheckConstraintDefinition }
  | { readonly kind: "dropCheck"; readonly constraintName: string }
  | { readonly kind: "addUniqueConstraint"; readonly columns: readonly string[]; readonly constraintName?: string }
  | { readonly kind: "dropUniqueConstraint"; readonly constraintName: string };

export interface AlterTableCommand {
  readonly kind: "alterTable";
  readonly tableName: string;
  readonly operations: readonly AlterTableOperation[];
}

export interface RawSqlCommand {
  readonly kind: "raw";
  readonly statements: readonly SqlStatement[];
}

export interface RenameTableCommand {
  readonly kind: "renameTable";
  readonly from: string;
  readonly to: string;
}

export interface TruncateTableCommand {
  readonly kind: "truncateTable";
  readonly tableName: string;
  readonly cascade: boolean;
  readonly restartIdentity: boolean;
}

export type SchemaCommand =
  | CreateTableCommand
  | DropTableCommand
  | CreateEnumCommand
  | DropEnumCommand
  | AlterTableCommand
  | RawSqlCommand
  | RenameTableCommand
  | TruncateTableCommand;

export class ColumnBuilder {
  #definition: ColumnDefinition;

  constructor(
    name: string,
    type: ColumnType,
    options: ColumnOptions = {},
    private readonly onChange: (definition: ColumnDefinition) => void = () => {}
  ) {
    this.#definition = {
      name,
      type,
      options,
      nullable: false,
      primary: false,
      unique: false
    };
  }

  nullable(): this {
    this.#definition = { ...this.#definition, nullable: true };
    this.onChange(this.#definition);
    return this;
  }

  notNullable(): this {
    this.#definition = { ...this.#definition, nullable: false };
    this.onChange(this.#definition);
    return this;
  }

  primary(): this {
    this.#definition = { ...this.#definition, primary: true };
    this.onChange(this.#definition);
    return this;
  }

  unique(): this {
    this.#definition = { ...this.#definition, unique: true };
    this.onChange(this.#definition);
    return this;
  }

  default(value: unknown): this {
    this.#definition = { ...this.#definition, defaultValue: value };
    this.onChange(this.#definition);
    return this;
  }

  defaultRaw(expression: string): this {
    this.#definition = { ...this.#definition, defaultExpression: expression };
    this.onChange(this.#definition);
    return this;
  }

  references(
    table: string,
    column = "id",
    options: Omit<ForeignKeyDefinition, "table" | "column"> = {}
  ): this {
    this.#definition = {
      ...this.#definition,
      foreignKey: { table, column, ...options }
    };
    this.onChange(this.#definition);
    return this;
  }

  toDefinition(): ColumnDefinition {
    return this.#definition;
  }
}

export class TableBuilder {
  readonly #tableName: string;
  readonly #columns: ColumnDefinition[] = [];
  readonly #indexes: IndexDefinition[] = [];
  readonly #checks: CheckConstraintDefinition[] = [];
  readonly #uniqueConstraints: TableUniqueConstraint[] = [];
  readonly #ifNotExists: boolean;
  #primaryKey?: CompositePrimaryKeyDefinition;

  constructor(tableName: string, options: { ifNotExists?: boolean } = {}) {
    this.#tableName = tableName;
    this.#ifNotExists = options.ifNotExists ?? false;
  }

  uuid(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "uuid", options);
  }

  string(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "string", options);
  }

  text(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "text", options);
  }

  enum(name: string, values: readonly string[], options?: EnumColumnOptions): ColumnBuilder;
  enum(name: string, options: EnumColumnOptions & { readonly enumName: string }): ColumnBuilder;
  enum(
    name: string,
    valuesOrOptions: readonly string[] | (EnumColumnOptions & { readonly enumName: string }),
    options: EnumColumnOptions = {}
  ): ColumnBuilder {
    return this.#addColumn(
      name,
      "enum",
      normalizeEnumOptions(this.#tableName, name, valuesOrOptions, options)
    );
  }

  integer(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "integer", options);
  }

  bigInteger(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "bigInteger", options);
  }

  boolean(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "boolean", options);
  }

  timestamp(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "timestamp", options);
  }

  date(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "date", options);
  }

  decimal(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "decimal", options);
  }

  json(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "json", options);
  }

  jsonb(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "jsonb", options);
  }

  timestamps(options: ColumnOptions & { nullable?: boolean } = {}): void {
    const createdAt = this.timestamp("created_at", options);
    const updatedAt = this.timestamp("updated_at", options);

    if (options.nullable) {
      createdAt.nullable();
      updatedAt.nullable();
    }
  }

  softDeletes(options: ColumnOptions = {}): ColumnBuilder {
    return this.timestamp("deleted_at", options).nullable();
  }

  createdBy(options: AuditUserColumnOptions = {}): ColumnBuilder {
    return this.#auditUserColumn("created_by", options);
  }

  updatedBy(options: AuditUserColumnOptions = {}): ColumnBuilder {
    return this.#auditUserColumn("updated_by", options);
  }

  userstamps(options: AuditUserColumnOptions = {}): void {
    this.createdBy(options);
    this.updatedBy({ ...options, nullable: true });
  }

  index(columns: readonly string[] | string, options?: string | IndexOptions): void {
    this.#indexes.push(indexDefinition(columns, options, false));
  }

  unique(columns: readonly string[] | string, options?: string | IndexOptions): void {
    this.#indexes.push(indexDefinition(columns, options, true));
  }

  primary(columns: readonly string[], options: { constraintName?: string } = {}): void {
    this.#primaryKey = { columns, ...options };
  }

  check(constraintName: string, expression: string): void {
    this.#checks.push({ constraintName, expression });
  }

  uniqueConstraint(columns: readonly string[] | string, constraintName?: string): void {
    const cols = arrayOf(columns);
    this.#uniqueConstraints.push({ columns: cols, ...(constraintName ? { constraintName } : {}) });
  }

  toCommand(): CreateTableCommand {
    return {
      kind: "createTable",
      tableName: this.#tableName,
      columns: this.#columns,
      indexes: this.#indexes,
      ...(this.#primaryKey ? { primaryKey: this.#primaryKey } : {}),
      checks: this.#checks,
      uniqueConstraints: this.#uniqueConstraints,
      ifNotExists: this.#ifNotExists
    };
  }

  #addColumn(name: string, type: ColumnType, options: ColumnOptions): ColumnBuilder {
    const columnIndex = this.#columns.length;
    const column = new ColumnBuilder(name, type, options, (definition) => {
      this.#columns[columnIndex] = definition;
    });
    this.#columns.push(column.toDefinition());
    return column;
  }

  #auditUserColumn(name: string, options: AuditUserColumnOptions): ColumnBuilder {
    const type = options.type ?? "uuid";
    const column = this.#addColumn(name, type, options);

    if (options.nullable ?? true) {
      column.nullable();
    }

    if (options.references) {
      column.references(
        options.references.table ?? "users",
        options.references.column ?? "id",
        foreignKeyOptions(options.references)
      );
    }

    return column;
  }
}

export class AlterTableBuilder {
  readonly #operations: AlterTableOperation[] = [];

  uuid(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "uuid", options);
  }

  string(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "string", options);
  }

  text(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "text", options);
  }

  enum(name: string, values: readonly string[], options?: EnumColumnOptions): ColumnBuilder;
  enum(name: string, options: EnumColumnOptions & { readonly enumName: string }): ColumnBuilder;
  enum(
    name: string,
    valuesOrOptions: readonly string[] | (EnumColumnOptions & { readonly enumName: string }),
    options: EnumColumnOptions = {}
  ): ColumnBuilder {
    return this.#addColumn(
      name,
      "enum",
      normalizeEnumOptions(undefined, name, valuesOrOptions, options)
    );
  }

  integer(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "integer", options);
  }

  bigInteger(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "bigInteger", options);
  }

  boolean(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "boolean", options);
  }

  timestamp(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "timestamp", options);
  }

  date(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "date", options);
  }

  decimal(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "decimal", options);
  }

  json(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "json", options);
  }

  jsonb(name: string, options: ColumnOptions = {}): ColumnBuilder {
    return this.#addColumn(name, "jsonb", options);
  }

  softDeletes(options: ColumnOptions = {}): ColumnBuilder {
    return this.timestamp("deleted_at", options).nullable();
  }

  createdBy(options: AuditUserColumnOptions = {}): ColumnBuilder {
    return this.#auditUserColumn("created_by", options);
  }

  updatedBy(options: AuditUserColumnOptions = {}): ColumnBuilder {
    return this.#auditUserColumn("updated_by", options);
  }

  userstamps(options: AuditUserColumnOptions = {}): void {
    this.createdBy(options);
    this.updatedBy({ ...options, nullable: true });
  }

  dropColumn(columnName: string, options: { ifExists?: boolean } = {}): void {
    this.#operations.push({
      kind: "dropColumn",
      columnName,
      ifExists: options.ifExists ?? false
    });
  }

  renameColumn(from: string, to: string): void {
    this.#operations.push({ kind: "renameColumn", from, to });
  }

  index(columns: readonly string[] | string, options?: string | IndexOptions): void {
    this.#operations.push({
      kind: "addIndex",
      index: indexDefinition(columns, options, false)
    });
  }

  unique(columns: readonly string[] | string, options?: string | IndexOptions): void {
    this.#operations.push({
      kind: "addIndex",
      index: indexDefinition(columns, options, true)
    });
  }

  addForeignKey(
    columns: readonly string[] | string,
    referencedTable: string,
    referencedColumns?: readonly string[] | string,
    options?: {
      constraintName?: string;
      onDelete?: ForeignKeyDefinition["onDelete"];
      onUpdate?: ForeignKeyDefinition["onUpdate"];
    }
  ): void {
    const cols = arrayOf(columns);
    const refCols = referencedColumns ? arrayOf(referencedColumns) : ["id"];
    this.#operations.push({
      kind: "addForeignKey",
      foreignKey: {
        columns: cols,
        referencedTable,
        referencedColumns: refCols,
        ...(options?.constraintName ? { constraintName: options.constraintName } : {}),
        ...(options?.onDelete ? { onDelete: options.onDelete } : {}),
        ...(options?.onUpdate ? { onUpdate: options.onUpdate } : {})
      }
    });
  }

  dropForeignKey(constraintName: string): void {
    this.#operations.push({ kind: "dropForeignKey", constraintName });
  }

  changeType(columnName: string, newType: ColumnType, options?: ColumnOptions & { using?: string }): void {
    const { using, ...rest } = options ?? {};
    this.#operations.push({
      kind: "changeType",
      columnName,
      newType,
      newOptions: rest,
      ...(using ? { using } : {})
    });
  }

  setNullable(columnName: string): void {
    this.#operations.push({ kind: "setNullable", columnName, nullable: true });
  }

  setNotNullable(columnName: string): void {
    this.#operations.push({ kind: "setNullable", columnName, nullable: false });
  }

  setDefault(columnName: string, value: unknown): void {
    this.#operations.push({ kind: "setDefault", columnName, value });
  }

  dropDefault(columnName: string): void {
    this.#operations.push({ kind: "dropDefault", columnName });
  }

  dropIndex(indexName: string): void {
    this.#operations.push({ kind: "dropIndex", indexName });
  }

  renameIndex(from: string, to: string): void {
    this.#operations.push({ kind: "renameIndex", from, to });
  }

  addPrimaryKey(columns: readonly string[] | string, options?: { constraintName?: string }): void {
    this.#operations.push({
      kind: "addPrimaryKey",
      columns: arrayOf(columns),
      ...(options?.constraintName ? { constraintName: options.constraintName } : {})
    });
  }

  dropPrimaryKey(constraintName: string): void {
    this.#operations.push({ kind: "dropPrimaryKey", constraintName });
  }

  addCheck(constraintName: string, expression: string): void {
    this.#operations.push({ kind: "addCheck", check: { constraintName, expression } });
  }

  dropCheck(constraintName: string): void {
    this.#operations.push({ kind: "dropCheck", constraintName });
  }

  addUniqueConstraint(columns: readonly string[] | string, constraintName?: string): void {
    this.#operations.push({
      kind: "addUniqueConstraint",
      columns: arrayOf(columns),
      ...(constraintName ? { constraintName } : {})
    });
  }

  dropUniqueConstraint(constraintName: string): void {
    this.#operations.push({ kind: "dropUniqueConstraint", constraintName });
  }

  toCommand(tableName: string): AlterTableCommand {
    return {
      kind: "alterTable",
      tableName,
      operations: this.#operations
    };
  }

  #addColumn(name: string, type: ColumnType, options: ColumnOptions): ColumnBuilder {
    const operationIndex = this.#operations.length;
    const column = new ColumnBuilder(name, type, options, (definition) => {
      this.#operations[operationIndex] = { kind: "addColumn", column: definition };
    });
    this.#operations.push({ kind: "addColumn", column: column.toDefinition() });
    return column;
  }

  #auditUserColumn(name: string, options: AuditUserColumnOptions): ColumnBuilder {
    const type = options.type ?? "uuid";
    const column = this.#addColumn(name, type, options);

    if (options.nullable ?? true) {
      column.nullable();
    }

    if (options.references) {
      column.references(
        options.references.table ?? "users",
        options.references.column ?? "id",
        foreignKeyOptions(options.references)
      );
    }

    return column;
  }
}

export class SchemaBuilder {
  constructor(private readonly executor: SchemaExecutor) {}

  async createTable(
    tableName: string,
    callback: (table: TableBuilder) => void,
    options: { ifNotExists?: boolean } = {}
  ): Promise<readonly SqlStatement[]> {
    const table = new TableBuilder(tableName, options);
    callback(table);
    return this.executor.execute([table.toCommand()]);
  }

  async alterTable(
    tableName: string,
    callback: (table: AlterTableBuilder) => void
  ): Promise<readonly SqlStatement[]> {
    const table = new AlterTableBuilder();
    callback(table);
    return this.executor.execute([table.toCommand(tableName)]);
  }

  async dropTable(
    tableName: string,
    options: { ifExists?: boolean; cascade?: boolean } = {}
  ): Promise<readonly SqlStatement[]> {
    return this.executor.execute([
      {
        kind: "dropTable",
        tableName,
        ifExists: options.ifExists ?? false,
        cascade: options.cascade ?? false
      }
    ]);
  }

  async createEnum(
    enumName: string,
    values: readonly string[],
    options: { ifNotExists?: boolean } = {}
  ): Promise<readonly SqlStatement[]> {
    return this.executor.execute([
      {
        kind: "createEnum",
        enumName,
        values,
        ifNotExists: options.ifNotExists ?? true
      }
    ]);
  }

  async dropEnum(
    enumName: string,
    options: { ifExists?: boolean; cascade?: boolean } = {}
  ): Promise<readonly SqlStatement[]> {
    return this.executor.execute([
      {
        kind: "dropEnum",
        enumName,
        ifExists: options.ifExists ?? true,
        cascade: options.cascade ?? false
      }
    ]);
  }

  async raw(sql: string, bindings: readonly unknown[] = []): Promise<readonly SqlStatement[]> {
    return this.executor.execute([{ kind: "raw", statements: [{ sql, bindings }] }]);
  }

  async renameTable(from: string, to: string): Promise<readonly SqlStatement[]> {
    return this.executor.execute([{ kind: "renameTable", from, to }]);
  }

  async truncate(
    tableName: string,
    options: { cascade?: boolean; restartIdentity?: boolean } = {}
  ): Promise<readonly SqlStatement[]> {
    return this.executor.execute([
      {
        kind: "truncateTable",
        tableName,
        cascade: options.cascade ?? false,
        restartIdentity: options.restartIdentity ?? false
      }
    ]);
  }
}

function arrayOf(value: readonly string[] | string): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

function indexDefinition(
  columns: readonly string[] | string,
  options: string | IndexOptions | undefined,
  unique: boolean
): IndexDefinition {
  const normalized = typeof options === "string" ? { name: options } : (options ?? {});
  const definition: IndexDefinition = {
    columns: arrayOf(columns),
    unique,
    concurrently: normalized.concurrently ?? false,
    ifNotExists: normalized.ifNotExists ?? false
  };

  return {
    ...definition,
    ...(normalized.name === undefined ? {} : { name: normalized.name }),
    ...(normalized.method === undefined ? {} : { method: normalized.method }),
    ...(normalized.where === undefined ? {} : { where: normalized.where })
  };
}

function normalizeEnumOptions(
  tableName: string | undefined,
  columnName: string,
  valuesOrOptions: readonly string[] | (EnumColumnOptions & { readonly enumName: string }),
  options: EnumColumnOptions
): ColumnOptions {
  const enumOptions: EnumColumnOptions = isReadonlyStringArray(valuesOrOptions)
    ? { ...options, values: valuesOrOptions }
    : valuesOrOptions;
  const enumName = enumOptions.enumName ?? `${tableName ?? "chronicle"}_${columnName}_enum`;

  return {
    ...enumOptions,
    enumName,
    ...(enumOptions.values === undefined ? {} : { enumValues: enumOptions.values }),
    useExistingEnum: enumOptions.useExisting ?? false
  };
}

function foreignKeyOptions(
  references: NonNullable<AuditUserColumnOptions["references"]>
): Omit<ForeignKeyDefinition, "table" | "column"> {
  return {
    ...(references.onDelete === undefined ? {} : { onDelete: references.onDelete }),
    ...(references.onUpdate === undefined ? {} : { onUpdate: references.onUpdate })
  };
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}
