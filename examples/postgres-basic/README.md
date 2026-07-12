# postgres-basic example

A minimal chronicle project demonstrating the PostgreSQL adapter with the full schema DSL.

## What it shows

- `chronicle.config.ts` with all available options
- A migration using `createTable`, enum columns, soft deletes, userstamps, and `CREATE INDEX CONCURRENTLY`
- Why `readonly transaction = false` is required for concurrent indexes

## Setup

```bash
# Start PostgreSQL
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres

# Install dependencies (from repo root)
pnpm install

# Preview SQL before applying
pnpm --filter chronicle-postgres-basic-example migration:plan

# Apply migrations
pnpm --filter chronicle-postgres-basic-example migration:up

# Check status
pnpm --filter chronicle-postgres-basic-example migration:status

# Dry-run with JSON output (CI-friendly)
pnpm --filter chronicle-postgres-basic-example migration:up -- --dry-run --format json

# Roll back latest batch
pnpm --filter chronicle-postgres-basic-example migration:down
```

## File layout

```
postgres-basic/
├── chronicle.config.ts          # Database + policy configuration
└── database/
    └── migrations/
        └── 20260601224500_create_users_table.ts
```

The example creates a `users` table through the TypeScript schema DSL with enum status,
soft deletes, audit user columns, and a concurrent email index. Because PostgreSQL
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, the migration sets
`readonly transaction = false`. chronicle guards against forgetting this at runtime.
