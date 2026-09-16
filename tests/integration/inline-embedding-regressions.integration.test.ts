import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HNSWIndex,
  PGEngine,
  PGVectorStore,
  type PGVectorStoreEmbeddings,
} from "../../src/index.js";
import { randomTableName, requireDatabaseUrl } from "./helpers.js";

describe("inline embedding regressions (real Postgres + pgvector)", () => {
  const tableName = randomTableName("it_inline_regression");
  const sequenceName = randomTableName("it_embedding_calls");
  const functions = {
    STABLE: randomTableName("it_stable_embed"),
    VOLATILE: randomTableName("it_volatile_embed"),
  };
  let engine: PGEngine;

  beforeAll(async () => {
    engine = PGEngine.fromConnectionString(requireDatabaseUrl(), { max: 1 });
    await engine.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await engine.pool.query(`CREATE SEQUENCE "${sequenceName}"`);
    for (const [volatility, name] of Object.entries(functions)) {
      // The result is deterministic; nextval only instruments execution count.
      // Unlike an IMMUTABLE SQL fake, these functions cannot be constant-folded.
      await engine.pool.query(`CREATE FUNCTION "${name}"(text) RETURNS vector
        LANGUAGE plpgsql ${volatility} AS $$
        BEGIN
          PERFORM nextval('${sequenceName}');
          RETURN ARRAY[octet_length($1)::real + 1, 1, 2, 3]::vector;
        END $$`);
    }
  });

  afterAll(async () => {
    try {
      await engine.dropTable(tableName);
      for (const name of Object.values(functions)) {
        await engine.pool.query(`DROP FUNCTION IF EXISTS "${name}"(text)`);
      }
      await engine.pool.query(`DROP SEQUENCE IF EXISTS "${sequenceName}"`);
    } finally {
      await engine.close();
    }
  });

  async function makeStore(
    mode: "template" | "legacy",
    functionName: string,
    contentType?: string,
  ) {
    await engine.initVectorstoreTable(tableName, 4, {
      overwriteExisting: true,
      storeMetadata: false,
    });
    if (contentType) {
      await engine.pool.query(
        `ALTER TABLE "${tableName}" ALTER COLUMN content TYPE ${contentType}`,
      );
    }
    const embeddings: PGVectorStoreEmbeddings = {
      embedDocuments: async () => {
        throw new Error("Unexpected client embedding");
      },
      embedQuery: async () => {
        throw new Error("Unexpected client embedding");
      },
      ...(mode === "template"
        ? {
            embedQueryInlineTemplate: (placeholder: string) =>
              `"${functionName}"(${placeholder})`,
          }
        : {
            embedQueryInline: (text: string) =>
              `"${functionName}"('${text.replaceAll("'", "''")}')`,
          }),
    };
    return PGVectorStore.initialize(engine, embeddings, tableName, {
      metadataJsonColumn: null,
    });
  }

  it.each(["varchar(100)", "char(100)"])(
    "inserts and updates a %s content column with a text embedding function",
    async (contentType) => {
      const store = await makeStore("template", functions.STABLE, contentType);
      const text = "O'Reilly 日本語";
      const ids = [
        ...(await store.addTexts([text])),
        ...(await store.addDocuments([{ pageContent: text, metadata: {} }])),
      ];
      const stored = await store.get({
        ids,
        include: ["documents", "embeddings"],
      });
      expect(stored.documents?.map((content) => content.trimEnd())).toEqual([
        text,
        text,
      ]);
      expect(stored.embeddings).toEqual(
        ids.map(() => [Buffer.byteLength(text) + 1, 1, 2, 3]),
      );

      await store.addTexts(["updated"], undefined, [ids[0]]);
      const updated = await store.get({
        ids: [ids[0]],
        include: ["documents", "embeddings"],
      });
      expect(updated.documents?.[0].trimEnd()).toBe("updated");
      expect(updated.embeddings).toEqual([[8, 1, 2, 3]]);
      await expect(store.addTexts(["x".repeat(101)])).rejects.toMatchObject({
        code: "22001",
      });
    },
  );

  describe.each(["STABLE", "VOLATILE"] as const)(
    "%s embedding function",
    (volatility) => {
      it.each(["template", "legacy"] as const)(
        "evaluates a %s query once and remains eligible for HNSW",
        async (mode) => {
          const store = await makeStore(mode, functions[volatility]);
          const docs = Array.from({ length: 100 }, (_, i) => ({
            pageContent: `document ${i}`,
            metadata: {},
          }));
          await store.addVectors(
            docs.map((_, i) => [i + 1, 1, 2, 3]),
            docs,
          );
          await engine.pool.query(`SELECT setval('${sequenceName}', 1, false)`);
          const results = await store.similaritySearchWithScore("query", 3);
          expect(results).toHaveLength(3);
          expect(results[0][0].pageContent).toBe("document 5");
          expect(results[0][1]).toBeCloseTo(0);
          expect(
            (
              await engine.pool.query(
                `SELECT last_value, is_called FROM "${sequenceName}"`,
              )
            ).rows[0],
          ).toEqual({ last_value: "1", is_called: true });

          const indexName = randomTableName("it_inline_hnsw");
          await store.applyVectorIndex(new HNSWIndex(), indexName);
          await engine.pool.query(`SELECT setval('${sequenceName}', 1, false)`);
          // max: 1 ensures the store uses this same client after it is released.
          const client = await engine.pool.connect();
          const querySpy = vi.spyOn(client, "query");
          client.release();
          let statement: [string, unknown[]];
          try {
            expect(await store.similaritySearch("query", 3)).toHaveLength(3);
            const call = querySpy.mock.calls.find(
              ([sql]) => typeof sql === "string" && sql.includes("as distance"),
            );
            expect(call).toBeDefined();
            statement = call as unknown as [string, unknown[]];
          } finally {
            querySpy.mockRestore();
          }
          expect(
            (
              await engine.pool.query(
                `SELECT last_value, is_called FROM "${sequenceName}"`,
              )
            ).rows[0],
          ).toEqual({ last_value: "1", is_called: true });

          const planClient = await engine.pool.connect();
          try {
            await planClient.query("BEGIN");
            await planClient.query("SET LOCAL enable_seqscan = off");
            const plan = await planClient.query(
              `EXPLAIN ${statement[0]}`,
              statement[1],
            );
            expect(
              plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
            ).toContain(`Index Scan using ${indexName}`);
          } finally {
            await planClient.query("ROLLBACK");
            planClient.release();
          }
        },
      );
    },
  );
});
