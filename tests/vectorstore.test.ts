import type { Pool } from "pg";
import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { PGEngine } from "../src/engine.js";
import { PGVectorStore } from "../src/vectorstore.js";
import { FakeEmbeddings } from "./helpers/fake-embeddings.js";
import {
  FakePool,
  type PartialQueryHandler,
  type QueryHandler,
} from "./helpers/fake-pool.js";

const baseColumns = [
  { column_name: "langchain_id", data_type: "uuid" },
  { column_name: "content", data_type: "text" },
  { column_name: "embedding", data_type: "USER-DEFINED" },
  { column_name: "category", data_type: "text" },
  { column_name: "langchain_metadata", data_type: "json" },
];

function makePool(
  columns: { column_name: string; data_type: string }[] = baseColumns,
  extra?: PartialQueryHandler,
): FakePool {
  const handler: QueryHandler = (text, values) => {
    if (text.includes("information_schema.columns")) {
      return { rows: columns };
    }
    const result = extra?.(text, values);
    if (result) return result;
    return { rows: [] };
  };
  return new FakePool(handler);
}

async function makeStore(
  pool: FakePool,
  metadataColumns: string[] = ["category"],
): Promise<PGVectorStore> {
  const engine = PGEngine.fromPool(pool as unknown as Pool);
  return PGVectorStore.initialize(engine, new FakeEmbeddings(2), "docs", {
    metadataColumns,
  });
}

describe("PGVectorStore.initialize", () => {
  it("resolves the metadata JSON column when it exists on the table", async () => {
    const store = await makeStore(makePool());
    expect(store.metadataJsonColumn).toBe("langchain_metadata");
    expect(store.metadataColumns).toEqual(["category"]);
  });

  it("throws when the id column does not exist", async () => {
    const columns = baseColumns.filter((c) => c.column_name !== "langchain_id");
    await expect(makeStore(makePool(columns))).rejects.toThrow(/Id column/);
  });

  it("throws when the embedding column is not a vector type", async () => {
    const columns = baseColumns.map((c) =>
      c.column_name === "embedding" ? { ...c, data_type: "text" } : c,
    );
    await expect(makeStore(makePool(columns))).rejects.toThrow(
      /is not type Vector/,
    );
  });

  it("drops the metadata JSON column when metadataJsonColumn is null", async () => {
    const engine = PGEngine.fromPool(makePool() as unknown as Pool);
    const store = await PGVectorStore.initialize(
      engine,
      new FakeEmbeddings(2),
      "docs",
      {
        metadataJsonColumn: null,
      },
    );
    expect(store.metadataJsonColumn).toBeUndefined();
  });
});

describe("PGVectorStore.addDocuments", () => {
  it("inserts a row per document with metadata split between typed columns and JSON", async () => {
    const pool = makePool();
    const store = await makeStore(pool);

    const ids = await store.addDocuments([
      new Document({
        pageContent: "hello",
        metadata: { category: "greeting", extra: "x" },
      }),
    ]);

    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);

    const insertCall = pool.calls.find((c) =>
      c.text.startsWith("INSERT INTO"),
    )!;
    expect(insertCall.text).toContain(
      '"langchain_id", "content", "embedding", "category", "langchain_metadata"',
    );
    expect(insertCall.text).toContain("ON CONFLICT");
    expect(insertCall.values?.[1]).toBe("hello");
    expect(insertCall.values?.[3]).toBe("greeting");
    expect(JSON.parse(insertCall.values?.[4] as string)).toEqual({
      extra: "x",
    });
  });

  it("uses the document id when provided instead of generating one", async () => {
    const pool = makePool();
    const store = await makeStore(pool);

    const ids = await store.addDocuments([
      new Document({ id: "fixed-id", pageContent: "hello", metadata: {} }),
    ]);

    expect(ids).toEqual(["fixed-id"]);
  });
});

describe("PGVectorStore.similaritySearchVectorWithScore", () => {
  it("maps rows into Documents, merging typed + JSON metadata", async () => {
    const pool = makePool(baseColumns, (text) => {
      if (text.includes("as distance")) {
        return {
          rows: [
            {
              langchain_id: "id-1",
              content: "hello world",
              embedding: "[0.1,0.2]",
              category: "greeting",
              langchain_metadata: { extra: "x" },
              distance: 0.05,
            },
          ],
        };
      }
      return undefined;
    });
    const store = await makeStore(pool);

    const results = await store.similaritySearchVectorWithScore([0.1, 0.2], 4);

    expect(results).toHaveLength(1);
    const [doc, score] = results[0];
    expect(doc.pageContent).toBe("hello world");
    expect(doc.id).toBe("id-1");
    expect(doc.metadata).toEqual({ extra: "x", category: "greeting" });
    expect(score).toBe(0.05);
  });
});

describe("PGVectorStore.delete", () => {
  it("combines id and filter conditions with AND", async () => {
    const pool = makePool();
    const store = await makeStore(pool);

    await store.delete({ ids: ["a", "b"], filter: { category: "greeting" } });

    const deleteCall = pool.calls.find((c) =>
      c.text.startsWith("DELETE FROM"),
    )!;
    expect(deleteCall.text).toContain('"langchain_id" IN ($1, $2)');
    expect(deleteCall.text).toContain("category = $3");
    expect(deleteCall.values).toEqual(["a", "b", "greeting"]);
  });

  it("is a no-op when neither ids nor filter are given", async () => {
    const pool = makePool();
    const store = await makeStore(pool);

    await store.delete();

    expect(pool.calls.some((c) => c.text.startsWith("DELETE FROM"))).toBe(
      false,
    );
  });
});

describe("PGVectorStore.get", () => {
  it("filters by ids and returns the requested fields", async () => {
    const pool = makePool(baseColumns, (text) => {
      if (text.startsWith("SELECT") && text.includes("LIMIT")) {
        return {
          rows: [
            {
              langchain_id: "id-1",
              content: "hello",
              category: "greeting",
              langchain_metadata: { extra: "x" },
            },
          ],
        };
      }
      return undefined;
    });
    const store = await makeStore(pool);

    const result = await store.get({ ids: ["id-1"] });

    expect(result.ids).toEqual(["id-1"]);
    expect(result.documents).toEqual(["hello"]);
    expect(result.metadatas?.[0]).toEqual({ extra: "x", category: "greeting" });
  });
});
