import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { Column, PGEngine } from "../src/engine.js";
import { FakePool } from "./helpers/fake-pool.js";

describe("PGEngine.initVectorstoreTable", () => {
  it("creates the extension and a table with default columns", async () => {
    const fakePool = new FakePool();
    const engine = PGEngine.fromPool(fakePool as unknown as Pool);

    await engine.initVectorstoreTable("my_table", 1536);

    const statements = fakePool.calls.map((c) => c.text);
    expect(statements[0]).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    const createTable = statements.find((s) => s.includes("CREATE TABLE"));
    expect(createTable).toBeDefined();
    expect(createTable).toContain('"public"."my_table"');
    expect(createTable).toContain('"langchain_id" UUID PRIMARY KEY');
    expect(createTable).toContain('"content" TEXT NOT NULL');
    expect(createTable).toContain('"embedding" vector(1536) NOT NULL');
    expect(createTable).toContain('"langchain_metadata" JSON');
  });

  it("adds typed metadata columns", async () => {
    const fakePool = new FakePool();
    const engine = PGEngine.fromPool(fakePool as unknown as Pool);

    await engine.initVectorstoreTable("my_table", 3, {
      metadataColumns: [
        new Column("category", "TEXT"),
        new Column("year", "INTEGER", false),
      ],
    });

    const createTable = fakePool.calls
      .map((c) => c.text)
      .find((s) => s.includes("CREATE TABLE"))!;
    expect(createTable).toContain('"category" TEXT');
    expect(createTable).toContain('"year" INTEGER NOT NULL');
  });

  it("drops the table first when overwriteExisting is set", async () => {
    const fakePool = new FakePool();
    const engine = PGEngine.fromPool(fakePool as unknown as Pool);

    await engine.initVectorstoreTable("my_table", 3, {
      overwriteExisting: true,
    });

    const statements = fakePool.calls.map((c) => c.text);
    expect(
      statements.some((s) =>
        s.includes('DROP TABLE IF EXISTS "public"."my_table"'),
      ),
    ).toBe(true);
  });
});

describe("PGEngine.dropTable", () => {
  it("issues a DROP TABLE IF EXISTS", async () => {
    const fakePool = new FakePool();
    const engine = PGEngine.fromPool(fakePool as unknown as Pool);

    await engine.dropTable("my_table");

    expect(fakePool.calls[0].text).toContain(
      'DROP TABLE IF EXISTS "public"."my_table"',
    );
  });
});
