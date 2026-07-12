import { describe, expect, it } from "vitest";
import { SchemaBuilder, type SqlStatement } from "@chronicle/core";
import { PostgresSchemaCompiler } from "../src/index.js";

describe("PostgresSchemaCompiler", () => {
  it("compiles create table commands", async () => {
    const compiler = new PostgresSchemaCompiler();
    const statements: SqlStatement[] = [];
    const schema = new SchemaBuilder({
      execute: (commands) => {
        statements.push(...commands.flatMap((command) => [...compiler.compile(command)]));
        return Promise.resolve(statements);
      }
    });

    await schema.createTable("users", (table) => {
      table.uuid("id").primary().defaultRaw("gen_random_uuid()");
      table.string("email", { length: 255 }).notNullable().unique();
      table.enum("status", ["active", "archived"], { enumName: "user_status" }).default("active");
      table.softDeletes({ withTimezone: true });
      table.userstamps({ references: { table: "users", onDelete: "set null" } });
      table.index("email", { concurrently: true, ifNotExists: true });
    });

    expect(statements.map((statement) => statement.sql)).toEqual([
      `DO $$
BEGIN
  CREATE TYPE "user_status" AS ENUM ('active', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;`,
      'CREATE TABLE "users" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "email" varchar(255) NOT NULL UNIQUE, "status" "user_status" NOT NULL DEFAULT \'active\', "deleted_at" timestamptz, "created_by" uuid, "updated_by" uuid, CONSTRAINT "users_created_by_foreign" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL, CONSTRAINT "users_updated_by_foreign" FOREIGN KEY ("updated_by") REFERENCES "users" ("id") ON DELETE SET NULL);',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_email_index" ON "users" ("email");'
    ]);
  });

  it("compiles alter table commands", async () => {
    const compiler = new PostgresSchemaCompiler();
    const statements: SqlStatement[] = [];
    const schema = new SchemaBuilder({
      execute: (commands) => {
        statements.push(...commands.flatMap((command) => [...compiler.compile(command)]));
        return Promise.resolve(statements);
      }
    });

    await schema.alterTable("users", (table) => {
      table.string("nickname").nullable();
      table.enum("status", ["active", "disabled"], { enumName: "user_status" });
      table.renameColumn("name", "full_name");
      table.dropColumn("legacy", { ifExists: true });
      table.dropColumn("unused");
      table.index("nickname", { method: "gin", where: "nickname IS NOT NULL" });
    });

    expect(statements.map((statement) => statement.sql)).toEqual([
      'ALTER TABLE "users" ADD COLUMN "nickname" varchar(255);',
      `DO $$
BEGIN
  CREATE TYPE "user_status" AS ENUM ('active', 'disabled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;`,
      'ALTER TABLE "users" ADD COLUMN "status" "user_status" NOT NULL;',
      'ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";',
      'ALTER TABLE "users" DROP COLUMN IF EXISTS "legacy";',
      'ALTER TABLE "users" DROP COLUMN "unused";',
      'CREATE INDEX "users_nickname_index" ON "users" USING gin ("nickname") WHERE nickname IS NOT NULL;'
    ]);
  });

  it("compiles standalone enum commands", async () => {
    const compiler = new PostgresSchemaCompiler();
    const statements: SqlStatement[] = [];
    const schema = new SchemaBuilder({
      execute: (commands) => {
        statements.push(...commands.flatMap((command) => [...compiler.compile(command)]));
        return Promise.resolve(statements);
      }
    });

    await schema.createEnum("invoice_status", ["draft", "paid"], { ifNotExists: false });
    await schema.dropEnum("invoice_status", { ifExists: true, cascade: true });

    expect(statements.map((statement) => statement.sql)).toEqual([
      "CREATE TYPE \"invoice_status\" AS ENUM ('draft', 'paid');",
      'DROP TYPE IF EXISTS "invoice_status" CASCADE;'
    ]);
  });

  it("compiles the full column type and literal matrix", async () => {
    const compiler = new PostgresSchemaCompiler();
    const statements: SqlStatement[] = [];
    const schema = new SchemaBuilder({
      execute: (commands) => {
        statements.push(...commands.flatMap((command) => [...compiler.compile(command)]));
        return Promise.resolve(statements);
      }
    });

    await schema.createTable(
      'quoted"table',
      (table) => {
        table.integer("age").default(1);
        table.bigInteger("visits").default(1n);
        table.boolean("enabled").default(false);
        table.timestamp("created_at").default(new Date("2026-01-01T00:00:00.000Z"));
        table.json("payload").default({ ok: true });
        table.jsonb("metadata").default(null);
        table.decimal("ratio", { precision: 8 });
        table.decimal("amount");
        table.decimal("priced", { precision: 10, scale: 2 });
        table.date("born_on");
        table.enum("status", ["active"], { useExisting: true });
        table.enum("mood", { enumName: "mood_enum" });
        table.boolean("approved").default(true);
        table.uuid("owner_id").references("users", "id", {
          onUpdate: "restrict"
        });
        table.unique("born_on");
        table.index(["age", "enabled"], "custom_index");
      },
      { ifNotExists: true }
    );
    await schema.dropTable("old_plain");
    await schema.dropTable("old_users", { ifExists: true, cascade: true });
    await schema.dropEnum("old_status", { ifExists: false });
    await schema.raw("select raw");

    expect(statements.map((statement) => statement.sql)).toContain(
      'CREATE TABLE IF NOT EXISTS "quoted""table" ("age" integer NOT NULL DEFAULT 1, "visits" bigint NOT NULL DEFAULT 1, "enabled" boolean NOT NULL DEFAULT false, "created_at" timestamp NOT NULL DEFAULT \'2026-01-01T00:00:00.000Z\', "payload" json NOT NULL DEFAULT \'{"ok":true}\', "metadata" jsonb NOT NULL DEFAULT NULL, "ratio" numeric(8) NOT NULL, "amount" numeric NOT NULL, "priced" numeric(10, 2) NOT NULL, "born_on" date NOT NULL, "status" "quoted""table_status_enum" NOT NULL, "mood" "mood_enum" NOT NULL, "approved" boolean NOT NULL DEFAULT true, "owner_id" uuid NOT NULL, CONSTRAINT "quoted""table_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON UPDATE RESTRICT);'
    );
    expect(statements.map((statement) => statement.sql)).toContain(
      'CREATE INDEX "custom_index" ON "quoted""table" ("age", "enabled");'
    );
    expect(statements.map((statement) => statement.sql)).toContain(
      'CREATE UNIQUE INDEX "quoted_table_born_on_unique" ON "quoted""table" ("born_on");'
    );
    expect(statements.map((statement) => statement.sql)).toContain('DROP TABLE "old_plain";');
    expect(statements.map((statement) => statement.sql)).toContain(
      'DROP TABLE IF EXISTS "old_users" CASCADE;'
    );
    expect(statements.map((statement) => statement.sql)).toContain('DROP TYPE "old_status";');
    expect(statements.map((statement) => statement.sql)).toContain("select raw");
  });

  it("rejects unsupported defaults and empty enum definitions", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    await expect(
      schema.createTable("broken", (table) => {
        table.string("bad").default(Symbol("bad"));
      })
    ).rejects.toThrow("Unsupported default value type");
    await expect(schema.createEnum("empty", [], { ifNotExists: false })).rejects.toThrow(
      "PostgreSQL enum values cannot be empty"
    );
  });

  it("compiles renameTable", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.renameTable("old_users", "users");

    expect(statements.map((s) => s.sql)).toEqual([
      'ALTER TABLE "old_users" RENAME TO "users";'
    ]);
  });

  it("compiles truncate with no options", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.truncate("logs");
    expect(statements.map((s) => s.sql)).toEqual(['TRUNCATE TABLE "logs";']);
  });

  it("compiles truncate with RESTART IDENTITY and CASCADE", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.truncate("logs", { restartIdentity: true, cascade: true });
    expect(statements.map((s) => s.sql)).toEqual([
      'TRUNCATE TABLE "logs" RESTART IDENTITY CASCADE;'
    ]);
  });

  it("compiles truncate with CASCADE only", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.truncate("logs", { cascade: true });
    expect(statements.map((s) => s.sql)).toEqual(['TRUNCATE TABLE "logs" CASCADE;']);
  });

  it("compiles createTable with composite PK, checks, and unique constraints", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.createTable("order_items", (table) => {
      table.uuid("order_id");
      table.uuid("product_id");
      table.integer("quantity");
      table.primary(["order_id", "product_id"], { constraintName: "order_items_pk" });
      table.check("order_items_qty_positive", "quantity > 0");
      table.uniqueConstraint(["order_id", "product_id"], "order_items_order_product_unique");
    });

    const sql = statements.map((s) => s.sql);
    expect(sql).toContain(
      'CREATE TABLE "order_items" ("order_id" uuid NOT NULL, "product_id" uuid NOT NULL, "quantity" integer NOT NULL, CONSTRAINT "order_items_pk" PRIMARY KEY ("order_id", "product_id"), CONSTRAINT "order_items_qty_positive" CHECK (quantity > 0), CONSTRAINT "order_items_order_product_unique" UNIQUE ("order_id", "product_id"));'
    );
  });

  it("compiles createTable with auto-named unique constraint", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.createTable("users", (table) => {
      table.string("email");
      table.uniqueConstraint("email");
    });

    const sql = statements.map((s) => s.sql);
    expect(sql).toContain(
      'CREATE TABLE "users" ("email" varchar(255) NOT NULL, CONSTRAINT "users_email_unique" UNIQUE ("email"));'
    );
  });

  it("compiles alter table new operations", async () => {
    const compiler = new PostgresSchemaCompiler();
    const statements: SqlStatement[] = [];
    const schema = new SchemaBuilder({
      execute: (commands) => {
        statements.push(...commands.flatMap((command) => [...compiler.compile(command)]));
        return Promise.resolve(statements);
      }
    });

    await schema.alterTable("orders", (table) => {
      table.addForeignKey("user_id", "users");
      table.addForeignKey(["org_id", "user_id"], "users", ["org_id", "id"], {
        constraintName: "orders_org_user_fk",
        onDelete: "cascade",
        onUpdate: "restrict"
      });
      table.dropForeignKey("orders_user_id_foreign");
      table.changeType("amount", "decimal", { precision: 10, scale: 2 });
      table.changeType("status", "integer", { using: "status::integer" });
      table.setNullable("nickname");
      table.setNotNullable("email");
      table.setDefault("status", "active");
      table.setDefault("count", 0);
      table.setDefault("enabled", true);
      table.setDefault("deleted_at", null);
      table.dropDefault("nickname");
      table.dropIndex("orders_legacy_index");
      table.renameIndex("orders_old_idx", "orders_new_idx");
      table.addPrimaryKey(["id", "tenant_id"], { constraintName: "orders_pk" });
      table.dropPrimaryKey("orders_pk");
      table.addCheck("orders_amount_positive", "amount > 0");
      table.dropCheck("orders_amount_positive");
      table.addUniqueConstraint(["user_id", "product_id"], "orders_user_product_unique");
      table.addUniqueConstraint("ref_no");
      table.dropUniqueConstraint("orders_user_product_unique");
    });

    const sql = statements.map((s) => s.sql);
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "users" ("id");'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_org_user_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "users" ("org_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" DROP CONSTRAINT "orders_user_id_foreign";'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "amount" TYPE numeric(10, 2);'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "status" TYPE integer USING status::integer;'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "nickname" DROP NOT NULL;'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "email" SET NOT NULL;'
    );
    expect(sql).toContain(
      "ALTER TABLE \"orders\" ALTER COLUMN \"status\" SET DEFAULT 'active';"
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "count" SET DEFAULT 0;'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "enabled" SET DEFAULT true;'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "deleted_at" SET DEFAULT NULL;'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "nickname" DROP DEFAULT;'
    );
    expect(sql).toContain('DROP INDEX "orders_legacy_index";');
    expect(sql).toContain('ALTER INDEX "orders_old_idx" RENAME TO "orders_new_idx";');
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_pk" PRIMARY KEY ("id", "tenant_id");'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" DROP CONSTRAINT "orders_pk";'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_positive" CHECK (amount > 0);'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" DROP CONSTRAINT "orders_amount_positive";'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_user_product_unique" UNIQUE ("user_id", "product_id");'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_ref_no_unique" UNIQUE ("ref_no");'
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" DROP CONSTRAINT "orders_user_product_unique";'
    );
  });

  it("deduplicates enum creation statements", async () => {
    const compiler = new PostgresSchemaCompiler();
    const schema = new SchemaBuilder({
      execute: (commands) =>
        Promise.resolve(commands.flatMap((command) => [...compiler.compile(command)]))
    });

    const statements = await schema.createTable("events", (table) => {
      table.enum("first_status", ["open"], { enumName: "event_status" });
      table.enum("second_status", ["open"], { enumName: "event_status" });
    });

    expect(statements.filter((statement) => statement.sql.includes("CREATE TYPE"))).toHaveLength(1);
  });
});
