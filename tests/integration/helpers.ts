export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for integration tests, e.g.\n" +
        "  DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration",
    );
  }
  return url;
}

export function randomTableName(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
