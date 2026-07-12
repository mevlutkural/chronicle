import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const databaseUrl =
  process.env.CHRONICLE_TEST_DATABASE_URL ??
  process.env.NODE_MT_TEST_DATABASE_URL ?? // legacy alias
  "postgres://postgres:postgres@localhost:55432/chronicle_test";
const keepPostgres =
  process.env.CHRONICLE_KEEP_POSTGRES === "1" ||
  process.env.NODE_MT_KEEP_POSTGRES === "1"; // legacy alias

await main();

async function main() {
  try {
    await run("docker", ["compose", "up", "-d", "chronicle-postgres"]);
    await waitForPostgres();
    await run("pnpm", ["vitest", "run", "packages/postgres/test/postgres.integration.test.ts"], {
      env: { ...process.env, CHRONICLE_TEST_DATABASE_URL: databaseUrl }
    });
  } finally {
    if (!keepPostgres) {
      await run("docker", ["compose", "down", "-v"], { allowFailure: true });
    }
  }
}

async function waitForPostgres() {
  const attempts = 60;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "chronicle-postgres",
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "chronicle_test"
      ],
      { allowFailure: true, quiet: true }
    );

    if (result === 0) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error("PostgreSQL container did not become ready in time.");
}

/**
 * @typedef {{
 *   readonly allowFailure?: boolean;
 *   readonly quiet?: boolean;
 *   readonly env?: NodeJS.ProcessEnv;
 * }} RunOptions
 */

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {RunOptions} [options]
 * @returns {Promise<number>}
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.quiet ? "ignore" : "inherit",
      env: options.env ?? process.env
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      const exitCode = code ?? 1;

      if (exitCode === 0 || options.allowFailure) {
        resolve(exitCode);
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${String(exitCode)}.`));
    });
  });
}
