import { describe, expect, it } from "vitest";
import {
  AlterTableBuilder,
  ColumnBuilder,
  Migration,
  SchemaBuilder,
  TableBuilder,
  type SchemaCommand
} from "../src/index.js";

describe("SchemaBuilder", () => {
  it("emits create table commands through the executor", async () => {
    const commands: SchemaCommand[] = [];
    const schema = new SchemaBuilder({
      execute: (received) => {
        commands.push(...received);
        return Promise.resolve([]);
      }
    });

    await schema.createTable("users", (table) => {
      table.uuid("id").primary();
      table.string("email").unique();
      table.enum("status", ["active", "archived"]);
      table.timestamps({ withTimezone: true });
      table.softDeletes();
      table.userstamps({ references: { table: "users", onDelete: "set null" } });
      table.index("email", { concurrently: true, ifNotExists: true });
    });

    expect(commands).toMatchObject([
      {
        kind: "createTable",
        tableName: "users",
        columns: [
          { name: "id", type: "uuid", primary: true },
          { name: "email", type: "string", unique: true },
          {
            name: "status",
            type: "enum",
            options: {
              enumName: "users_status_enum",
              enumValues: ["active", "archived"]
            }
          },
          { name: "created_at", type: "timestamp", options: { withTimezone: true } },
          { name: "updated_at", type: "timestamp", options: { withTimezone: true } },
          { name: "deleted_at", type: "timestamp", nullable: true },
          { name: "created_by", type: "uuid", nullable: true },
          { name: "updated_by", type: "uuid", nullable: true }
        ],
        indexes: [{ columns: ["email"], concurrently: true, ifNotExists: true }]
      }
    ]);
  });

  it("covers table and alter helper variants", async () => {
    const commands: SchemaCommand[] = [];
    const schema = new SchemaBuilder({
      execute: (received) => {
        commands.push(...received);
        return Promise.resolve([]);
      }
    });

    await schema.createTable(
      "everything",
      (table) => {
        table.text("body");
        table.integer("count");
        table.bigInteger("big_count");
        table.boolean("enabled");
        table.date("birthday");
        table.decimal("price", { precision: 10, scale: 2 });
        table.json("payload");
        table.jsonb("metadata");
        table.enum("role", { enumName: "role_enum", useExisting: true });
        table.timestamps({ nullable: true });
        table.createdBy({
          type: "integer",
          nullable: false,
          references: { onUpdate: "cascade" }
        });
        table.updatedBy({ type: "bigInteger" });
        table.index("body");
        table.unique(["body", "enabled"], "everything_body_enabled_unique");
      },
      { ifNotExists: true }
    );
    await schema.alterTable("everything", (table) => {
      table.uuid("owner_id");
      table.text("summary");
      table.integer("rank");
      table.bigInteger("big_rank");
      table.boolean("visible");
      table.timestamp("published_at");
      table.date("reviewed_on");
      table.decimal("ratio");
      table.json("draft");
      table.jsonb("search");
      table.enum("status", { enumName: "status_enum", useExisting: true });
      table.softDeletes();
      table.createdBy({
        nullable: false,
        references: { onDelete: "cascade", onUpdate: "restrict" }
      });
      table.updatedBy();
      table.userstamps();
      table.enum("priority", ["high"]);
      table.dropColumn("unused");
      table.unique("summary", { name: "everything_summary_unique" });
    });
    await schema.dropTable("everything", { ifExists: true, cascade: true });
    await schema.dropTable("plain");
    await schema.createEnum("status_enum", ["active"]);
    await schema.dropEnum("status_enum");
    await schema.raw("select 1");

    expect(commands.map((command) => command.kind)).toEqual([
      "createTable",
      "alterTable",
      "dropTable",
      "dropTable",
      "createEnum",
      "dropEnum",
      "raw"
    ]);
  });

  it("keeps the abstract migration transaction default enabled", () => {
    class TestMigration extends Migration {
      async up(): Promise<void> {}
    }

    expect(new TestMigration().transaction).toBe(true);
  });

  it("supports standalone column builders without change listeners", () => {
    const column = new ColumnBuilder("name", "string");

    column.nullable().notNullable().primary().unique().default("value").defaultRaw("now()");

    expect(column.toDefinition()).toMatchObject({
      name: "name",
      nullable: false,
      primary: true,
      unique: true,
      defaultExpression: "now()"
    });
  });

  it("renameTable emits correct command", async () => {
    const commands: SchemaCommand[] = [];
    const schema = new SchemaBuilder({
      execute: (received) => {
        commands.push(...received);
        return Promise.resolve([]);
      }
    });

    await schema.renameTable("old_users", "users");

    expect(commands).toEqual([{ kind: "renameTable", from: "old_users", to: "users" }]);
  });

  it("truncate emits correct command with options", async () => {
    const commands: SchemaCommand[] = [];
    const schema = new SchemaBuilder({
      execute: (received) => {
        commands.push(...received);
        return Promise.resolve([]);
      }
    });

    await schema.truncate("users", { cascade: true, restartIdentity: true });

    expect(commands).toEqual([
      { kind: "truncateTable", tableName: "users", cascade: true, restartIdentity: true }
    ]);
  });

  it("truncate uses defaults when no options provided", async () => {
    const commands: SchemaCommand[] = [];
    const schema = new SchemaBuilder({
      execute: (received) => {
        commands.push(...received);
        return Promise.resolve([]);
      }
    });

    await schema.truncate("logs");

    expect(commands).toEqual([
      { kind: "truncateTable", tableName: "logs", cascade: false, restartIdentity: false }
    ]);
  });
});

describe("TableBuilder", () => {
  it("primary() adds composite primary key definition", () => {
    const table = new TableBuilder("orders");
    table.uuid("user_id");
    table.uuid("product_id");
    table.primary(["user_id", "product_id"], { constraintName: "orders_pk" });

    const command = table.toCommand();
    expect(command.primaryKey).toEqual({
      columns: ["user_id", "product_id"],
      constraintName: "orders_pk"
    });
  });

  it("primary() without constraintName", () => {
    const table = new TableBuilder("order_items");
    table.uuid("order_id");
    table.uuid("item_id");
    table.primary(["order_id", "item_id"]);

    const command = table.toCommand();
    expect(command.primaryKey).toEqual({ columns: ["order_id", "item_id"] });
  });

  it("check() adds check constraints", () => {
    const table = new TableBuilder("products");
    table.decimal("price");
    table.check("products_price_positive", "price > 0");
    table.check("products_price_max", "price < 10000");

    const command = table.toCommand();
    expect(command.checks).toEqual([
      { constraintName: "products_price_positive", expression: "price > 0" },
      { constraintName: "products_price_max", expression: "price < 10000" }
    ]);
  });

  it("uniqueConstraint() adds unique constraints with and without name", () => {
    const table = new TableBuilder("users");
    table.string("email");
    table.string("username");
    table.uniqueConstraint(["email"], "users_email_unique");
    table.uniqueConstraint("username");

    const command = table.toCommand();
    expect(command.uniqueConstraints).toEqual([
      { columns: ["email"], constraintName: "users_email_unique" },
      { columns: ["username"] }
    ]);
  });

  it("defaults checks and uniqueConstraints to empty arrays", () => {
    const table = new TableBuilder("simple");
    table.uuid("id");

    const command = table.toCommand();
    expect(command.checks).toEqual([]);
    expect(command.uniqueConstraints).toEqual([]);
    expect(command.primaryKey).toBeUndefined();
  });
});

describe("AlterTableBuilder", () => {
  it("addForeignKey with defaults", () => {
    const builder = new AlterTableBuilder();
    builder.addForeignKey("user_id", "users");

    const command = builder.toCommand("orders");
    expect(command.operations).toEqual([
      {
        kind: "addForeignKey",
        foreignKey: {
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"]
        }
      }
    ]);
  });

  it("addForeignKey with full options", () => {
    const builder = new AlterTableBuilder();
    builder.addForeignKey(["user_id", "org_id"], "users", ["id", "org_id"], {
      constraintName: "orders_user_fk",
      onDelete: "cascade",
      onUpdate: "restrict"
    });

    const command = builder.toCommand("orders");
    expect(command.operations).toEqual([
      {
        kind: "addForeignKey",
        foreignKey: {
          columns: ["user_id", "org_id"],
          referencedTable: "users",
          referencedColumns: ["id", "org_id"],
          constraintName: "orders_user_fk",
          onDelete: "cascade",
          onUpdate: "restrict"
        }
      }
    ]);
  });

  it("dropForeignKey", () => {
    const builder = new AlterTableBuilder();
    builder.dropForeignKey("orders_user_id_foreign");

    expect(builder.toCommand("orders").operations).toEqual([
      { kind: "dropForeignKey", constraintName: "orders_user_id_foreign" }
    ]);
  });

  it("changeType without using", () => {
    const builder = new AlterTableBuilder();
    builder.changeType("age", "bigInteger");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "changeType", columnName: "age", newType: "bigInteger", newOptions: {} }
    ]);
  });

  it("changeType with using", () => {
    const builder = new AlterTableBuilder();
    builder.changeType("status", "integer", { using: "status::integer" });

    expect(builder.toCommand("users").operations).toEqual([
      {
        kind: "changeType",
        columnName: "status",
        newType: "integer",
        newOptions: {},
        using: "status::integer"
      }
    ]);
  });

  it("setNullable and setNotNullable", () => {
    const builder = new AlterTableBuilder();
    builder.setNullable("bio");
    builder.setNotNullable("email");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "setNullable", columnName: "bio", nullable: true },
      { kind: "setNullable", columnName: "email", nullable: false }
    ]);
  });

  it("setDefault and dropDefault", () => {
    const builder = new AlterTableBuilder();
    builder.setDefault("status", "active");
    builder.dropDefault("nickname");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "setDefault", columnName: "status", value: "active" },
      { kind: "dropDefault", columnName: "nickname" }
    ]);
  });

  it("dropIndex and renameIndex", () => {
    const builder = new AlterTableBuilder();
    builder.dropIndex("users_email_index");
    builder.renameIndex("old_idx", "new_idx");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "dropIndex", indexName: "users_email_index" },
      { kind: "renameIndex", from: "old_idx", to: "new_idx" }
    ]);
  });

  it("addPrimaryKey and dropPrimaryKey", () => {
    const builder = new AlterTableBuilder();
    builder.addPrimaryKey(["id", "tenant_id"], { constraintName: "users_pk" });
    builder.dropPrimaryKey("users_pk");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "addPrimaryKey", columns: ["id", "tenant_id"], constraintName: "users_pk" },
      { kind: "dropPrimaryKey", constraintName: "users_pk" }
    ]);
  });

  it("addPrimaryKey with single string column", () => {
    const builder = new AlterTableBuilder();
    builder.addPrimaryKey("id");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "addPrimaryKey", columns: ["id"] }
    ]);
  });

  it("addCheck and dropCheck", () => {
    const builder = new AlterTableBuilder();
    builder.addCheck("users_age_check", "age >= 0");
    builder.dropCheck("users_age_check");

    expect(builder.toCommand("users").operations).toEqual([
      { kind: "addCheck", check: { constraintName: "users_age_check", expression: "age >= 0" } },
      { kind: "dropCheck", constraintName: "users_age_check" }
    ]);
  });

  it("addUniqueConstraint and dropUniqueConstraint", () => {
    const builder = new AlterTableBuilder();
    builder.addUniqueConstraint(["email", "tenant_id"], "users_email_tenant_unique");
    builder.addUniqueConstraint("username");
    builder.dropUniqueConstraint("users_email_tenant_unique");

    expect(builder.toCommand("users").operations).toEqual([
      {
        kind: "addUniqueConstraint",
        columns: ["email", "tenant_id"],
        constraintName: "users_email_tenant_unique"
      },
      { kind: "addUniqueConstraint", columns: ["username"] },
      { kind: "dropUniqueConstraint", constraintName: "users_email_tenant_unique" }
    ]);
  });
});
