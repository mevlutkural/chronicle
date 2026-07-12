import { defineConfig } from "@chronicle/core";
import { postgres } from "@chronicle/postgres";

export default defineConfig({
  adapter: postgres({
    connectionString: process.env.DATABASE_URL
  }),
  migrations: {
    directory: "database/migrations",
    namespace: "default"
  },
  policies: {
    requireDown: true,
    preventProductionRollback: true
  }
});
