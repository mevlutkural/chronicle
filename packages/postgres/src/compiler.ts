import type {
  AlterTableCommand,
  AlterTableOperation,
  ColumnDefinition,
  ColumnType,
  CreateTableCommand,
  DropTableCommand,
  CreateEnumCommand,
  DropEnumCommand,
  IndexDefinition,
  RawSqlCommand,
  RenameTableCommand,
  TruncateTableCommand,
  SchemaCommand,
  SqlStatement
} from "@chronicle/core";

export class PostgresSchemaCompiler {
  compile(command: SchemaCommand): readonly SqlStatement[] {
    switch (command.kind) {
      case "createTable":
        return compileCreateTable(command);
      case "dropTable":
        return [compileDropTable(command)];
      case "createEnum":
        return [compileCreateEnum(command)];
      case "dropEnum":
        return [compileDropEnum(command)];
      case "alterTable":
        return compileAlterTable(command);
      case "raw":
        return compileRaw(command);
      case "renameTable":
        return [compileRenameTable(command)];
      case "truncateTable":
        return [compileTruncateTable(command)];
    }

    /* v8 ignore next */
    return assertNever(command);
  }
}

function compileCreateTable(command: CreateTableCommand): readonly SqlStatement[] {
  const tableName = quoteIdent(command.tableName);
  const ifNotExists = command.ifNotExists ? " IF NOT EXISTS" : "";
  const columnSql = command.columns.map((column) => compileColumn(command.tableName, column));
  const foreignKeys = command.columns
    .filter((column) => column.foreignKey)
    .map((column) => compileForeignKey(command.tableName, column));

  const extraConstraints: string[] = [];

  if (command.primaryKey) {
    const cols = command.primaryKey.columns.map((c) => quoteIdent(c)).join(", ");
    if (command.primaryKey.constraintName) {
      extraConstraints.push(`CONSTRAINT ${quoteIdent(command.primaryKey.constraintName)} PRIMARY KEY (${cols})`);
    } else {
      extraConstraints.push(`PRIMARY KEY (${cols})`);
    }
  }

  for (const check of command.checks ?? []) {
    extraConstraints.push(`CONSTRAINT ${quoteIdent(check.constraintName)} CHECK (${check.expression})`);
  }

  for (const uc of command.uniqueConstraints ?? []) {
    const cols = uc.columns.map((c) => quoteIdent(c)).join(", ");
    if (uc.constraintName) {
      extraConstraints.push(`CONSTRAINT ${quoteIdent(uc.constraintName)} UNIQUE (${cols})`);
    } else {
      const autoName = `${command.tableName}_${uc.columns.join("_")}_unique`;
      extraConstraints.push(`CONSTRAINT ${quoteIdent(autoName)} UNIQUE (${cols})`);
    }
  }

  const statements: SqlStatement[] = [
    ...compileEnumColumns(command.tableName, command.columns),
    {
      sql: `CREATE TABLE${ifNotExists} ${tableName} (${[...columnSql, ...foreignKeys, ...extraConstraints].join(", ")});`
    }
  ];

  for (const index of command.indexes) {
    statements.push(compileIndex(command.tableName, index));
  }

  return statements;
}

function compileDropTable(command: DropTableCommand): SqlStatement {
  const ifExists = command.ifExists ? " IF EXISTS" : "";
  const cascade = command.cascade ? " CASCADE" : "";

  return {
    sql: `DROP TABLE${ifExists} ${quoteIdent(command.tableName)}${cascade};`
  };
}

function compileCreateEnum(command: CreateEnumCommand): SqlStatement {
  const values = enumValues(command.values);

  if (!command.ifNotExists) {
    return { sql: `CREATE TYPE ${quoteIdent(command.enumName)} AS ENUM (${values});` };
  }

  return {
    sql: `DO $$
BEGIN
  CREATE TYPE ${quoteIdent(command.enumName)} AS ENUM (${values});
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;`
  };
}

function compileDropEnum(command: DropEnumCommand): SqlStatement {
  const ifExists = command.ifExists ? " IF EXISTS" : "";
  const cascade = command.cascade ? " CASCADE" : "";

  return {
    sql: `DROP TYPE${ifExists} ${quoteIdent(command.enumName)}${cascade};`
  };
}

function compileRenameTable(command: RenameTableCommand): SqlStatement {
  return { sql: `ALTER TABLE ${quoteIdent(command.from)} RENAME TO ${quoteIdent(command.to)};` };
}

function compileTruncateTable(command: TruncateTableCommand): SqlStatement {
  const restartIdentity = command.restartIdentity ? " RESTART IDENTITY" : "";
  const cascade = command.cascade ? " CASCADE" : "";
  return { sql: `TRUNCATE TABLE ${quoteIdent(command.tableName)}${restartIdentity}${cascade};` };
}

function compileAlterTable(command: AlterTableCommand): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];

  for (const operation of command.operations) {
    const compiled = compileAlterOperation(command.tableName, operation);
    statements.push(...compiled);
  }

  return statements;
}

function compileAlterOperation(
  tableName: string,
  operation: AlterTableOperation
): readonly SqlStatement[] {
  switch (operation.kind) {
    case "addColumn":
      return [
        ...compileEnumColumns(tableName, [operation.column]),
        {
          sql: `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${compileColumn(tableName, operation.column)};`
        }
      ];
    case "dropColumn":
      return [
        {
          sql: `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN${operation.ifExists ? " IF EXISTS" : ""} ${quoteIdent(operation.columnName)};`
        }
      ];
    case "renameColumn":
      return [
        {
          sql: `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(operation.from)} TO ${quoteIdent(operation.to)};`
        }
      ];
    case "addIndex":
      return [compileIndex(tableName, operation.index)];
    case "addForeignKey": {
      const fk = operation.foreignKey;
      const constraintName = fk.constraintName ?? `${tableName}_${fk.columns.join("_")}_foreign`;
      const cols = fk.columns.map((c) => quoteIdent(c)).join(", ");
      const refCols = fk.referencedColumns.map((c) => quoteIdent(c)).join(", ");
      const parts = [
        `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(constraintName)}`,
        `FOREIGN KEY (${cols})`,
        `REFERENCES ${quoteIdent(fk.referencedTable)} (${refCols})`
      ];
      if (fk.onDelete) parts.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
      if (fk.onUpdate) parts.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
      return [{ sql: `${parts.join(" ")};` }];
    }
    case "dropForeignKey":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT ${quoteIdent(operation.constraintName)};` }
      ];
    case "changeType": {
      const pgType = columnTypeToSql(tableName, operation.newType, operation.newOptions);
      const using = operation.using ? ` USING ${operation.using}` : "";
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(operation.columnName)} TYPE ${pgType}${using};` }
      ];
    }
    case "setNullable":
      if (operation.nullable) {
        return [{ sql: `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(operation.columnName)} DROP NOT NULL;` }];
      } else {
        return [{ sql: `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(operation.columnName)} SET NOT NULL;` }];
      }
    case "setDefault":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(operation.columnName)} SET DEFAULT ${literal(operation.value)};` }
      ];
    case "dropDefault":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(operation.columnName)} DROP DEFAULT;` }
      ];
    case "dropIndex":
      return [{ sql: `DROP INDEX ${quoteIdent(operation.indexName)};` }];
    case "renameIndex":
      return [{ sql: `ALTER INDEX ${quoteIdent(operation.from)} RENAME TO ${quoteIdent(operation.to)};` }];
    case "addPrimaryKey": {
      const constraintName = operation.constraintName ?? `${tableName}_pkey`;
      const cols = operation.columns.map((c) => quoteIdent(c)).join(", ");
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(constraintName)} PRIMARY KEY (${cols});` }
      ];
    }
    case "dropPrimaryKey":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT ${quoteIdent(operation.constraintName)};` }
      ];
    case "addCheck":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(operation.check.constraintName)} CHECK (${operation.check.expression});` }
      ];
    case "dropCheck":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT ${quoteIdent(operation.constraintName)};` }
      ];
    case "addUniqueConstraint": {
      const constraintName = operation.constraintName ?? `${tableName}_${operation.columns.join("_")}_unique`;
      const cols = operation.columns.map((c) => quoteIdent(c)).join(", ");
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(constraintName)} UNIQUE (${cols});` }
      ];
    }
    case "dropUniqueConstraint":
      return [
        { sql: `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT ${quoteIdent(operation.constraintName)};` }
      ];
  }

  /* v8 ignore next */
  return assertNever(operation);
}

function compileRaw(command: RawSqlCommand): readonly SqlStatement[] {
  return command.statements;
}

function compileColumn(tableName: string, column: ColumnDefinition): string {
  const parts = [quoteIdent(column.name), columnType(tableName, column)];

  if (column.primary) {
    parts.push("PRIMARY KEY");
  }

  if (!column.nullable && !column.primary) {
    parts.push("NOT NULL");
  }

  if (column.unique && !column.primary) {
    parts.push("UNIQUE");
  }

  if (column.defaultExpression) {
    parts.push(`DEFAULT ${column.defaultExpression}`);
  } else if ("defaultValue" in column) {
    parts.push(`DEFAULT ${literal(column.defaultValue)}`);
  }

  return parts.join(" ");
}

function compileForeignKey(tableName: string, column: ColumnDefinition): string {
  const foreignKey = column.foreignKey;

  /* v8 ignore next 3 */
  if (!foreignKey) {
    throw new Error("Expected a foreign key definition.");
  }

  const name = quoteIdent(`${tableName}_${column.name}_foreign`);
  const parts = [
    `CONSTRAINT ${name}`,
    `FOREIGN KEY (${quoteIdent(column.name)})`,
    `REFERENCES ${quoteIdent(foreignKey.table)} (${quoteIdent(foreignKey.column)})`
  ];

  if (foreignKey.onDelete) {
    parts.push(`ON DELETE ${foreignKey.onDelete.toUpperCase()}`);
  }

  if (foreignKey.onUpdate) {
    parts.push(`ON UPDATE ${foreignKey.onUpdate.toUpperCase()}`);
  }

  return parts.join(" ");
}

function compileIndex(tableName: string, index: IndexDefinition): SqlStatement {
  const unique = index.unique ? "UNIQUE " : "";
  const concurrently = index.concurrently ? "CONCURRENTLY " : "";
  const ifNotExists = index.ifNotExists ? "IF NOT EXISTS " : "";
  const name = index.name ?? indexName(tableName, index);
  const method = index.method ? ` USING ${index.method}` : "";
  const columns = index.columns.map((column) => quoteIdent(column)).join(", ");
  const where = index.where ? ` WHERE ${index.where}` : "";

  return {
    sql: `CREATE ${unique}INDEX ${concurrently}${ifNotExists}${quoteIdent(name)} ON ${quoteIdent(tableName)}${method} (${columns})${where};`
  };
}

function columnType(tableName: string, column: ColumnDefinition): string {
  return columnTypeToSql(tableName, column.type, column.options);
}

function columnTypeToSql(tableName: string, type: ColumnType, options: { length?: number; precision?: number; scale?: number; withTimezone?: boolean; enumName?: string } = {}): string {
  switch (type) {
    case "uuid": return "uuid";
    case "string": return `varchar(${String(options.length ?? 255)})`;
    case "text": return "text";
    case "enum": return quoteIdent(options.enumName ?? `${tableName}_enum`);
    case "integer": return "integer";
    case "bigInteger": return "bigint";
    case "boolean": return "boolean";
    case "timestamp": return options.withTimezone ? "timestamptz" : "timestamp";
    case "date": return "date";
    case "decimal": return decimalTypeSql(options);
    case "json": return "json";
    case "jsonb": return "jsonb";
  }
}

function compileEnumColumns(
  tableName: string,
  columns: readonly ColumnDefinition[]
): readonly SqlStatement[] {
  const enumColumns = columns.filter(shouldCreateEnumForColumn);
  const seen = new Set<string>();
  const statements: SqlStatement[] = [];

  for (const column of enumColumns) {
    const name = enumName(tableName, column);

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);
    statements.push(
      compileCreateEnum({
        kind: "createEnum",
        enumName: name,
        values: column.options.enumValues,
        ifNotExists: true
      })
    );
  }

  return statements;
}

function decimalTypeSql(options: { precision?: number; scale?: number }): string {
  if (options.precision && options.scale !== undefined) {
    return `numeric(${String(options.precision)}, ${String(options.scale)})`;
  }

  if (options.precision) {
    return `numeric(${String(options.precision)})`;
  }

  return "numeric";
}

function indexName(tableName: string, index: IndexDefinition): string {
  const suffix = index.unique ? "unique" : "index";
  return `${tableName}_${index.columns.join("_")}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(value: unknown): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value instanceof Date) {
    return quoteLiteral(value.toISOString());
  }

  if (typeof value === "string") {
    return quoteLiteral(value);
  }

  if (typeof value === "object") {
    return quoteLiteral(JSON.stringify(value));
  }

  throw new Error(`Unsupported default value type: ${typeof value}`);
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function enumName(tableName: string, column: ColumnDefinition): string {
  return column.options.enumName ?? `${tableName}_${column.name}_enum`;
}

function shouldCreateEnumForColumn(column: ColumnDefinition): column is ColumnDefinition & {
  readonly options: ColumnDefinition["options"] & { readonly enumValues: readonly string[] };
} {
  return (
    column.type === "enum" &&
    !column.options.useExistingEnum &&
    column.options.enumValues !== undefined &&
    column.options.enumValues.length > 0
  );
}

function enumValues(values: readonly string[]): string {
  if (values.length === 0) {
    throw new Error("PostgreSQL enum values cannot be empty.");
  }

  return values.map((value) => quoteLiteral(value)).join(", ");
}

/* v8 ignore next 3 */
function assertNever(value: never): never {
  throw new Error(`Unhandled PostgreSQL schema command: ${JSON.stringify(value)}`);
}
