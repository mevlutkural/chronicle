import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureMigration {
  readonly id: string;
  readonly upSql?: string;
  readonly downSql?: string;
  readonly transaction?: boolean;
}

export interface MigrationFixtureContext {
  readonly directory: string;
  readonly cleanup: () => Promise<void>;
}

export async function createMigrationFixtures(
  migrations: readonly FixtureMigration[]
): Promise<MigrationFixtureContext> {
  const directory = path.join(
    tmpdir(),
    `chronicle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(directory, { recursive: true });

  for (const migration of migrations) {
    const upBody = migration.upSql
      ? `await context.db.execute({ sql: ${JSON.stringify(migration.upSql)} });`
      : "// up: no-op";
    const downBody = migration.downSql
      ? `await context.db.execute({ sql: ${JSON.stringify(migration.downSql)} });`
      : "// down: no-op";
    const transaction =
      migration.transaction === false ? "\n  readonly transaction = false;" : "";

    const content = `import { Migration } from "@chronicle/core";
export default class extends Migration {${transaction}
  async up(context) { ${upBody} }
  async down(context) { ${downBody} }
}
`;
    await writeFile(path.join(directory, `${migration.id}.js`), content, "utf8");
  }

  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
