import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests need a real Postgres+pgvector instance; run them
    // explicitly via `npm run test:integration` (see vitest.integration.config.ts).
    exclude: ["node_modules/**", "dist/**", "tests/integration/**"],
  },
});
