import type { Pool } from "pg";
import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { PGEngine } from "../src/engine.js";
import { PGVector } from "../src/legacy/vectorstore.js";
import { FakeEmbeddings } from "./helpers/fake-embeddings.js";
import {
  FakePool,
  type PartialQueryHandler,
  type QueryHandler,
} from "./helpers/fake-pool.js";

const COLLECTION_UUID = "b1a0a2ac-4b8a-4c1e-9f0a-9a2e6b6c9b39";

function makePool(extra?: PartialQueryHandler): FakePool {
  const handler: QueryHandler = (text, values) => {
    if (text.includes("SELECT uuid FROM langchain_pg_collection")) {
      return { rows: [{ uuid: COLLECTION_UUID }] };
    }
    const result = extra?.(text, values);
    if (result) return result;
    return { rows: [] };
  };
  return new FakePool(handler);
}

async function makeStore(pool: FakePool): Promise<PGVector> {
  const engine = PGEngine.fromPool(pool as unknown as Pool);
  return PGVector.initialize(engine, new FakeEmbeddings(2));
}

describe("PGVector (legacy)", () => {
  it("reuses an existing collection uuid instead of creating a new one", async () => {
    const pool = makePool();
    await makeStore(pool);

    expect(
      pool.calls.some((c) =>
        c.text.startsWith("INSERT INTO langchain_pg_collection"),
      ),
    ).toBe(false);
  });

  it("creates a collection row when none exists yet", async () => {
    let created = false;
    const pool = new FakePool((text) => {
      if (text.includes("SELECT uuid FROM langchain_pg_collection")) {
        return { rows: created ? [{ uuid: COLLECTION_UUID }] : [] };
      }
      if (text.startsWith("INSERT INTO langchain_pg_collection")) {
        created = true;
        return { rows: [] };
      }
      return { rows: [] };
    });

    await makeStore(pool);

    expect(
      pool.calls.some((c) =>
        c.text.startsWith("INSERT INTO langchain_pg_collection"),
      ),
    ).toBe(true);
  });

  it("addDocuments inserts embeddings scoped to the collection id", async () => {
    const pool = makePool();
    const store = await makeStore(pool);

    await store.addDocuments([
      new Document({ pageContent: "hello", metadata: { a: 1 } }),
    ]);

    const insertCall = pool.calls.find((c) =>
      c.text.startsWith("INSERT INTO langchain_pg_embedding"),
    )!;
    expect(insertCall.values?.[1]).toBe(COLLECTION_UUID);
    expect(insertCall.values?.[3]).toBe("hello");
    expect(JSON.parse(insertCall.values?.[4] as string)).toEqual({ a: 1 });
  });

  it("similaritySearchVectorWithScore scopes the query to the collection", async () => {
    const pool = makePool((text) => {
      if (
        text.includes("FROM langchain_pg_embedding") &&
        text.includes("ORDER BY")
      ) {
        return {
          rows: [
            {
              id: "id-1",
              document: "hello",
              cmetadata: { a: 1 },
              embedding: "[0.1,0.2]",
              distance: 0.2,
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
    expect(doc.pageContent).toBe("hello");
    expect(doc.metadata).toEqual({ a: 1 });
    expect(score).toBe(0.2);

    const selectCall = pool.calls.find((c) => c.text.includes("ORDER BY"))!;
    expect(selectCall.values?.[0]).toBe(COLLECTION_UUID);
  });
});
