# multi-tenant example

Demonstrates running chronicle migrations per-tenant using isolated namespaces
on a shared PostgreSQL database.

## How it works

Each tenant gets its own namespace in `chronicle_migrations`:

```
namespace = "tenant:acme"
namespace = "tenant:globex"
```

Migration history is fully isolated — rolling back tenant A never affects tenant B,
even when both share the same database and migration files.

## Setup

```bash
# Single shared database (both tenants use same DB in this example)
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres

# Run migrations for all tenants
pnpm --filter chronicle-multi-tenant-example migrate:up

# Show per-tenant status
pnpm --filter chronicle-multi-tenant-example migrate:status

# Baseline all tenants (first-time adoption of an existing database)
pnpm --filter chronicle-multi-tenant-example migrate:baseline
```

## File layout

```
multi-tenant/
├── run.ts                         # Migration runner — iterates over tenant list
└── database/
    └── migrations/
        └── 20260601000001_create_tenants_table.ts
```

## Real-world pattern

In production, the tenant list typically comes from a control-plane database:

```ts
const tenants = await controlPlane.query("SELECT id, connection_string FROM tenants");

for (const tenant of tenants) {
  const migrator = new Migrator(resolveConfig({
    adapter: postgres({ connectionString: tenant.connection_string }),
    migrations: { directory: "database/migrations", namespace: `tenant:${tenant.id}` },
  }));
  await migrator.up();
}
```
