import { Document } from "@langchain/core/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HybridSearchConfig,
  PGEngine,
  PGVectorStore,
  type PGVectorStoreEmbeddings,
} from "../../src/index.js";
import { randomTableName, requireDatabaseUrl } from "./helpers.js";

describe("inline embeddings (integration, real Postgres + pgvector)", () => {
  const tableName = randomTableName("it_inline");
  const functionName = randomTableName("it_embed");
  let engine: PGEngine;

  beforeAll(async () => {
    engine = PGEngine.fromConnectionString(requireDatabaseUrl());
    await engine.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    // A deterministic SQL embedding function exercises native pg bindings
    // without requiring a database-specific ML extension or external service.
    await engine.pool.query(`
      CREATE FUNCTION "${functionName}"(text) RETURNS vector
      LANGUAGE SQL IMMUTABLE AS $$
        SELECT ARRAY[octet_length($1)::real + 1, 1, 2, 3]::vector
      $$
    `);
  });

  afterAll(async () => {
    try {
      await engine.dropTable(tableName);
      await engine.pool.query(
        `DROP FUNCTION IF EXISTS "${functionName}"(text)`,
      );
    } finally {
      await engine.close();
    }
  });

  it.each([
    { mode: "template", hybrid: false, metadata: false },
    { mode: "template", hybrid: false, metadata: true },
    { mode: "template", hybrid: true, metadata: true },
    { mode: "legacy", hybrid: false, metadata: true },
    { mode: "both", hybrid: true, metadata: true },
  ] as const)(
    "inserts and searches with $mode hooks (hybrid: $hybrid, metadata: $metadata)",
    async ({ mode, hybrid, metadata }) => {
      const hybridSearchConfig = hybrid
        ? new HybridSearchConfig({ tsvColumn: "body_tsv" })
        : undefined;
      await engine.initVectorstoreTable(tableName, 4, {
        overwriteExisting: true,
        contentColumn: "body",
        embeddingColumn: "vec",
        metadataColumns: metadata
          ? [{ name: "category", dataType: "TEXT" }]
          : [],
        storeMetadata: metadata,
        hybridSearchConfig,
      });
      const embeddings: PGVectorStoreEmbeddings = {
        embedDocuments: vi.fn(async () => {
          throw new Error("Client document embedding should be skipped");
        }),
        embedQuery: vi.fn(async () => {
          throw new Error("Client query embedding should be skipped");
        }),
      };
      if (mode !== "legacy") {
        embeddings.embedQueryInlineTemplate = vi.fn(
          (placeholder) => `"${functionName}"(${placeholder}::text)`,
        );
      }
      if (mode !== "template") {
        embeddings.embedQueryInline = vi.fn(
          (text) => `"${functionName}"('${text.replaceAll("'", "''")}')`,
        );
      }
      const store = await PGVectorStore.initialize(
        engine,
        embeddings,
        tableName,
        {
          contentColumn: "body",
          embeddingColumn: "vec",
          metadataColumns: metadata ? ["category"] : [],
          metadataJsonColumn: metadata ? "langchain_metadata" : null,
          hybridSearchConfig,
        },
      );
      const text = `O'Reilly'); DROP TABLE "${tableName}"; -- 日本語 $1`;
      const docMetadata = metadata ? { category: mode, extra: "kept" } : {};
      const ids = await store.addDocuments([
        new Document({ pageContent: text, metadata: docMetadata }),
        new Document({ pageContent: "", metadata: docMetadata }),
      ]);
      try {
        const stored = await store.get({
          ids,
          include: ["documents", "embeddings", "metadatas"],
        });
        const index = stored.ids.indexOf(ids[0]);
        expect(stored.documents?.[index]).toBe(text);
        expect(stored.embeddings?.[index]).toEqual([
          Buffer.byteLength(text) + 1,
          1,
          2,
          3,
        ]);
        expect(stored.metadatas?.[index]).toEqual(docMetadata);
        expect(stored.embeddings?.[stored.ids.indexOf(ids[1])]).toEqual([
          1, 1, 2, 3,
        ]);

        const results = await store.similaritySearchWithScore(text, 2, {
          langchain_id: ids[0],
        });
        expect(results).toHaveLength(1);
        expect(results[0][0].pageContent).toBe(text);
        expect(Number.isFinite(results[0][1])).toBe(true);
        const empty = await store.similaritySearch("", 1, {
          langchain_id: ids[1],
        });
        expect(empty[0].pageContent).toBe("");

        await store.addTexts(["updated"], [docMetadata], [ids[0]]);
        const updated = await store.get({
          ids: [ids[0]],
          include: ["documents", "embeddings"],
        });
        expect(updated.documents).toEqual(["updated"]);
        expect(updated.embeddings).toEqual([[8, 1, 2, 3]]);
        expect(embeddings.embedDocuments).not.toHaveBeenCalled();
        expect(embeddings.embedQuery).not.toHaveBeenCalled();
        if (mode === "both")
          expect(embeddings.embedQueryInline).not.toHaveBeenCalled();
      } finally {
        await store.delete({ ids });
      }
    },
  );
});
