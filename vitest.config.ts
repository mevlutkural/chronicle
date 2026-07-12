import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  },
  resolve: {
    alias: {
      "@chronicle/core": fromRoot("./packages/core/src/index.ts"),
      "@chronicle/postgres": fromRoot("./packages/postgres/src/index.ts"),
      "@chronicle/testing": fromRoot("./packages/testing/src/index.ts"),
      "chronicle": fromRoot("./packages/cli/src/index.ts")
    }
  }
});
