import { Document } from "@langchain/core/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGEngine } from "../../src/engine.js";
import { HNSWIndex } from "../../src/indexes.js";
import { PGVectorStore } from "../../src/vectorstore.js";
import { FakeEmbeddings } from "../helpers/fake-embeddings.js";
import { randomTableName, requireDatabaseUrl } from "./helpers.js";

describe("PGVectorStore (integration, real Postgres + pgvector)", () => {
  const tableName = randomTableName("it_vectorstore");
  let engine: PGEngine;
  let store: PGVectorStore;

  beforeAll(async () => {
    engine = PGEngine.fromConnectionString(requireDatabaseUrl());
    await engine.initVectorstoreTable(tableName, 4, {
      metadataColumns: [{ name: "category", dataType: "TEXT" }],
    });
    store = await PGVectorStore.initialize(
      engine,
      new FakeEmbeddings(4),
      tableName,
      {
        metadataColumns: ["category"],
      },
    );
  });

  afterAll(async () => {
    await engine.dropTable(tableName);
    await engine.close();
  });

  it("adds documents and finds them via similarity search", async () => {
    const ids = await store.addDocuments([
      new Document({
        pageContent: "Postgres is a relational database.",
        metadata: { category: "db" },
      }),
      new Document({
        pageContent: "Cats are small domesticated mammals.",
        metadata: { category: "animals" },
      }),
    ]);
    expect(ids).toHaveLength(2);

    const results = await store.similaritySearch("Postgres database", 1);
    expect(results).toHaveLength(1);
    expect(results[0].pageContent).toContain("Postgres");
  });

  it("filters results by metadata", async () => {
    const results = await store.similaritySearch("mammals", 5, {
      category: "animals",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((d) => d.metadata.category === "animals")).toBe(true);
  });

  it("supports get(), getByIds(), and delete()", async () => {
    const [id] = await store.addDocuments([
      new Document({
        pageContent: "Temporary document",
        metadata: { category: "temp" },
      }),
    ]);

    const byIds = await store.getByIds([id]);
    expect(byIds).toHaveLength(1);
    expect(byIds[0].pageContent).toBe("Temporary document");

    const got = await store.get({ where: { category: "temp" } });
    expect(got.ids).toContain(id);

    await store.delete({ ids: [id] });
    expect(await store.getByIds([id])).toHaveLength(0);
  });

  it("supports maximal marginal relevance search", async () => {
    const results = await store.maxMarginalRelevanceSearch("database", {
      k: 2,
      fetchK: 5,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("creates and drops a vector index", async () => {
    await store.applyVectorIndex(new HNSWIndex({ m: 8, efConstruction: 32 }));
    expect(await store.isValidIndex()).toBe(true);

    await store.dropVectorIndex();
    expect(await store.isValidIndex()).toBe(false);
  });
});
