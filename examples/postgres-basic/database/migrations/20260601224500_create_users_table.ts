import { Migration, type MigrationContext } from "@chronicle/core";

export default class CreateUsersTable extends Migration {
  readonly transaction = false;

  async up({ schema }: MigrationContext): Promise<void> {
    await schema.createTable("users", (table) => {
      table.uuid("id").primary().defaultRaw("gen_random_uuid()");
      table.string("email", { length: 255 }).notNullable().unique();
      table.string("name", { length: 120 }).notNullable();
      table.enum("status", ["active", "suspended", "archived"]).default("active");
      table.timestamps({ withTimezone: true });
      table.softDeletes({ withTimezone: true });
      table.userstamps({ references: { table: "users", onDelete: "set null" } });
      table.index("email", { concurrently: true, ifNotExists: true });
    });
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropTable("users", { ifExists: true });
  }
}
