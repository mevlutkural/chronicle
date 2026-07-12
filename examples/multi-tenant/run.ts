/**
 * Multi-tenant migration runner example.
 *
 * Each tenant gets its own namespace in chronicle_migrations, so migration
 * history is isolated even when all tenants share the same database.
 *
 * Usage:
 *   tsx run.ts up        — migrate all tenants
 *   tsx run.ts status    — show status for all tenants
 *   tsx run.ts baseline  — baseline all tenants (first-time adoption)
 */

import { Migrator, resolveConfig, createLogger } from "@chronicle/core";
import { postgres } from "@chronicle/postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In a real app these would come from a database / config service
const TENANTS = [
  { id: "acme", connectionString: process.env.DATABASE_URL_ACME ?? process.env.DATABASE_URL },
  { id: "globex", connectionString: process.env.DATABASE_URL_GLOBEX ?? process.env.DATABASE_URL },
];

const command = process.argv[2] ?? "status";

for (const tenant of TENANTS) {
  if (!tenant.connectionString) {
    console.error(`No DATABASE_URL for tenant ${tenant.id}`);
    process.exit(1);
  }

  const adapter = postgres({ connectionString: tenant.connectionString });

  const config = resolveConfig({
    adapter,
    migrations: {
      directory: path.join(__dirname, "database/migrations"),
      namespace: `tenant:${tenant.id}`,
    },
    policies: {
      requireDown: true,
      preventProductionRollback: true,
    },
  });

  const migrator = new Migrator(config);

  // Attach structured logger per tenant
  createLogger(migrator.events, { level: "info" });

  console.log(`\n── Tenant: ${tenant.id} ──`);

  switch (command) {
    case "up": {
      const result = await migrator.up();
      if (result.executions.length === 0) {
        console.log("  No pending migrations.");
      }
      break;
    }
    case "status": {
      const statuses = await migrator.status();
      for (const s of statuses) {
        const badge = s.status === "applied" ? "✅" : s.status === "pending" ? "⏳" : "❌";
        console.log(`  ${badge} ${s.id}  [${s.status}]`);
      }
      break;
    }
    case "baseline": {
      const result = await migrator.baseline();
      console.log(`  Baselined ${result.executions.length} migration(s).`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }

  await adapter.close();
}
