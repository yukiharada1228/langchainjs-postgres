import { Document } from "@langchain/core/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGEngine } from "../../src/engine.js";
import { PGVector } from "../../src/legacy/vectorstore.js";
import { FakeEmbeddings } from "../helpers/fake-embeddings.js";
import { randomTableName, requireDatabaseUrl } from "./helpers.js";

describe("PGVector legacy (integration, real Postgres + pgvector)", () => {
  const collectionName = randomTableName("it_legacy");
  let engine: PGEngine;
  let store: PGVector;

  beforeAll(async () => {
    engine = PGEngine.fromConnectionString(requireDatabaseUrl());
    store = await PGVector.initialize(engine, new FakeEmbeddings(4), {
      collectionName,
    });
  });

  afterAll(async () => {
    await store.deleteCollection();
    await engine.close();
  });

  it("adds documents and finds them via similarity search", async () => {
    await store.addDocuments([
      new Document({
        pageContent: "Legacy vector store test document.",
        metadata: { source: "legacy" },
      }),
      new Document({
        pageContent: "Something unrelated about gardening.",
        metadata: { source: "legacy" },
      }),
    ]);

    const results = await store.similaritySearch("legacy test document", 1);
    expect(results).toHaveLength(1);
    expect(results[0].pageContent).toContain("Legacy");
  });

  it("supports delete() and getByIds()", async () => {
    const [id] = await store.addDocuments([
      new Document({ pageContent: "Deletable document", metadata: {} }),
    ]);

    expect(await store.getByIds([id])).toHaveLength(1);
    await store.delete({ ids: [id] });
    expect(await store.getByIds([id])).toHaveLength(0);
  });
});
