import { Migration, type MigrationContext } from "@chronicle/core";

export default class CreateTenantsTable extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.createTable("tenants", (table) => {
      table.uuid("id").primary().defaultRaw("gen_random_uuid()");
      table.string("slug", { length: 63 }).notNullable();
      table.string("name", { length: 255 }).notNullable();
      table.enum("plan", ["free", "pro", "enterprise"]).default("free");
      table.timestamps({ withTimezone: true });
      table.softDeletes({ withTimezone: true });
      table.uniqueConstraint(["slug"], "tenants_slug_unique");
    });
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropTable("tenants", { ifExists: true });
  }
}
