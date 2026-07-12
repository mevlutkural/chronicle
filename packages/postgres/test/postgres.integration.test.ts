import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineConfig, Migrator, resolveConfig } from "@chronicle/core";
import { postgres } from "../src/index.js";

const databaseUrl =
  process.env.CHRONICLE_TEST_DATABASE_URL ?? process.env.NODE_MT_TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const tempDirs: string[] = [];

describeIfDatabase("PostgreSQL integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("runs, verifies, dry-runs, and rolls back a migration", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chronicle-"));
    tempDirs.push(dir);

    await writeFile(
      path.join(dir, "20260101000000_create_chronicle_test_table.ts"),
      `import { Migration, type MigrationContext } from "@chronicle/core";

export default class CreateChronicleTestTable extends Migration {
  readonly transaction = false;

  async up({ schema }: MigrationContext): Promise<void> {
    await schema.createTable("chronicle_test_table", table => {
      table.uuid("id").primary();
      table.string("name");
      table.index("name", { concurrently: true, ifNotExists: true });
    });
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropTable("chronicle_test_table", { ifExists: true });
  }
}
`,
      "utf8"
    );

    const adapter = postgres({ connectionString: databaseUrl });
    const config = resolveConfig(
      defineConfig({
        adapter,
        migrations: { directory: dir, namespace: `test_${String(Date.now())}` }
      })
    );
    const migrator = new Migrator(config);

    try {
      const dryRun = await migrator.up({ dryRun: true });
      expect(dryRun.statements.map((statement) => statement.sql)).toContain(
        'CREATE TABLE "chronicle_test_table" ("id" uuid PRIMARY KEY, "name" varchar(255) NOT NULL);'
      );

      const up = await migrator.up();
      expect(up.executions).toHaveLength(1);
      expect((await migrator.verify()).ok).toBe(true);
      expect(await migrator.up()).toMatchObject({ executions: [] });

      const down = await migrator.down({ step: 1 });
      expect(down.executions).toHaveLength(1);
    } finally {
      await adapter.execute('DROP TABLE IF EXISTS "chronicle_test_table"');
      await adapter.close();
    }
  });
});
