import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    // Each test file gets its own temp SQLite file, so files can run in parallel.
    testTimeout: 20_000,
    // npm run coverage: the spec requires at least 90% of lines in packages/core.
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 90 },
    },
  },
});
