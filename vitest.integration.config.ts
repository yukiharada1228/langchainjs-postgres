import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Suites share a database and initialize the vector extension. PostgreSQL
    // can race on concurrent CREATE EXTENSION IF NOT EXISTS calls.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
