import { Document } from "@langchain/core/documents";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  HybridSearchConfig,
  PGEngine,
  PGVectorStore,
  type PGVectorStoreEmbeddings,
} from "../src/index.js";
import { FakeEmbeddings } from "./helpers/fake-embeddings.js";
import { FakePool } from "./helpers/fake-pool.js";

const text = "O'Reilly'); DROP TABLE docs; -- 日本語 $1";
const row = {
  langchain_id: "id-1",
  content: text,
  embedding: "[0.1,0.2]",
  category: "docs",
  langchain_metadata: { extra: true },
  distance: 0.25,
};

function makePool(): FakePool {
  return new FakePool((sql) => {
    if (sql.includes("information_schema.columns")) {
      return {
        rows: [
          { column_name: "langchain_id", data_type: "uuid" },
          { column_name: "content", data_type: "text" },
          { column_name: "embedding", data_type: "USER-DEFINED" },
          { column_name: "category", data_type: "text" },
          { column_name: "langchain_metadata", data_type: "json" },
          { column_name: "content_tsv", data_type: "tsvector" },
        ],
      };
    }
    return { rows: sql.includes("as distance") ? [{ ...row }] : [] };
  });
}

function makeEmbeddings(mode: "template" | "legacy" | "both") {
  const embeddings = Object.assign(new FakeEmbeddings(2), {
    model: "model_id",
    embedQueryInlineTemplate:
      mode === "legacy"
        ? undefined
        : vi.fn(function (this: { model: string }, placeholder: string) {
            return `embedding('${this.model}', ${placeholder})::vector`;
          }),
    embedQueryInline:
      mode === "template"
        ? undefined
        : vi.fn(function (this: { model: string }, content: string) {
            return `embedding('${this.model}', '${content.replaceAll("'", "''")}')::vector`;
          }),
  });
  vi.spyOn(embeddings, "embedDocuments");
  vi.spyOn(embeddings, "embedQuery");
  return embeddings;
}

describe.each(["template", "legacy", "both"] as const)(
  "PGVectorStore inline embeddings (%s)",
  (mode) => {
    it.each([
      "addTexts",
      "addDocuments",
      "addVectors",
      "fromTexts",
      "fromDocuments",
    ] as const)("%s inserts inline embeddings and metadata", async (method) => {
      const pool = makePool();
      const engine = PGEngine.fromPool(pool as unknown as Pool);
      const embeddings = makeEmbeddings(mode);
      const config = {
        engine,
        tableName: "docs",
        metadataColumns: ["category"],
      };
      const texts = [text, "second document"];
      const ids = ["id-1", "id-2"];
      const metadatas = texts.map(() => ({ category: "docs", extra: true }));
      const documents = texts.map(
        (pageContent, i) =>
          new Document({ id: ids[i], pageContent, metadata: metadatas[i] }),
      );
      if (method === "fromTexts") {
        await PGVectorStore.fromTexts(texts, metadatas, embeddings, {
          ...config,
          ids,
        });
      } else if (method === "fromDocuments") {
        await PGVectorStore.fromDocuments(documents, embeddings, config);
      } else {
        const store = await PGVectorStore.initialize(
          engine,
          embeddings,
          "docs",
          config,
        );
        const result =
          method === "addTexts"
            ? await store.addTexts(texts, metadatas, ids)
            : method === "addVectors"
              ? await store.addVectors([[], []], documents)
              : await store.addDocuments(documents);
        expect(result).toEqual(ids);
      }

      const inserts = pool.calls.filter((call) =>
        call.text.startsWith("INSERT INTO"),
      );
      expect(inserts).toHaveLength(2);
      for (const [i, insert] of inserts.entries()) {
        expect(insert.values).toEqual([
          ids[i],
          texts[i],
          "docs",
          '{"extra":true}',
        ]);
        if (mode !== "legacy") {
          expect(insert.text).toContain(
            "VALUES ($1, $2::text, embedding('model_id', $2)::vector, $3, $4)",
          );
          expect(insert.text).not.toContain(texts[i]);
        } else {
          expect(insert.text).toContain(
            `embedding('model_id', '${texts[i].replaceAll("'", "''")}')::vector`,
          );
        }
      }
      expect(embeddings.embedDocuments).not.toHaveBeenCalled();
      if (mode === "both")
        expect(embeddings.embedQueryInline).not.toHaveBeenCalled();
      if (mode !== "legacy")
        expect(embeddings.embedQueryInlineTemplate).toHaveBeenCalledWith("$2");
      else expect(embeddings.embedQueryInline).toHaveBeenCalledWith(text);
    });

    it.each(["similaritySearch", "similaritySearchWithScore"] as const)(
      "%s uses inline SQL with filters and returns documents",
      async (method) => {
        const pool = makePool();
        const embeddings = makeEmbeddings(mode);
        const store = await PGVectorStore.initialize(
          PGEngine.fromPool(pool as unknown as Pool),
          embeddings,
          "docs",
          { metadataColumns: ["category"] },
        );

        const result = await store[method](text, 4, { category: "docs" });
        expect(result).toHaveLength(1);
        const document =
          method === "similaritySearch"
            ? result[0]
            : (result[0] as [Document, number])[0];
        expect(document).toMatchObject({
          id: "id-1",
          pageContent: text,
          metadata: { category: "docs", extra: true },
        });
        if (method === "similaritySearchWithScore")
          expect(result[0]).toEqual([document, 0.25]);
        const search = pool.calls.find((call) =>
          call.text.includes("as distance"),
        )!;
        expect(search.text).toContain("WHERE category = $1");
        expect(search.text).toContain(
          "WITH __langchain_query_embedding AS MATERIALIZED",
        );
        expect(search.text).toContain(
          'cosine_distance("embedding", (SELECT embedding FROM __langchain_query_embedding))',
        );
        expect(search.text).toContain(
          'ORDER BY "embedding" <=> (SELECT embedding FROM __langchain_query_embedding)',
        );
        if (mode !== "legacy") {
          expect(search.text).toContain(
            "SELECT embedding('model_id', $2)::vector AS embedding",
          );
          expect(search.text).toContain("LIMIT $3");
          expect(search.text).not.toContain(text);
          expect(search.values).toEqual(["docs", text, 4]);
          expect(embeddings.embedQueryInlineTemplate).toHaveBeenCalledWith(
            "$2",
          );
        } else {
          expect(search.text).toContain(
            `embedding('model_id', '${text.replaceAll("'", "''")}')::vector`,
          );
          expect(search.text).toContain("LIMIT $2");
          expect(search.values).toEqual(["docs", 4]);
        }
        expect(embeddings.embedQuery).not.toHaveBeenCalled();
        if (mode === "both")
          expect(embeddings.embedQueryInline).not.toHaveBeenCalled();
      },
    );

    it("uses explicit vectors for insertion and vector search", async () => {
      const pool = makePool();
      const embeddings = makeEmbeddings(mode);
      const store = await PGVectorStore.initialize(
        PGEngine.fromPool(pool as unknown as Pool),
        embeddings,
        "docs",
      );
      await store.addVectors(
        [[0.1, 0.2]],
        [new Document({ id: "id-1", pageContent: text })],
      );
      await store.similaritySearchVectorWithScore([0.1, 0.2], 3);
      const insert = pool.calls.find((call) =>
        call.text.startsWith("INSERT INTO"),
      )!;
      expect(insert.values).toEqual(["id-1", text, "[0.1,0.2]", "{}"]);
      const search = pool.calls.find((call) =>
        call.text.includes("as distance"),
      )!;
      expect(search.values).toEqual(["[0.1,0.2]", 3]);
      expect(search.text).not.toContain("WITH __langchain_query_embedding");
      if (embeddings.embedQueryInlineTemplate)
        expect(embeddings.embedQueryInlineTemplate).not.toHaveBeenCalled();
      if (embeddings.embedQueryInline)
        expect(embeddings.embedQueryInline).not.toHaveBeenCalled();
    });
  },
);

describe("PGVectorStore template binding", () => {
  it("binds empty query text once and reuses the computed embedding", async () => {
    const pool = makePool();
    const embeddings = makeEmbeddings("template");
    const store = await PGVectorStore.initialize(
      PGEngine.fromPool(pool as unknown as Pool),
      embeddings,
      "docs",
    );
    await store.similaritySearch("");
    const search = pool.calls.find((call) =>
      call.text.includes("as distance"),
    )!;
    expect(
      search.text.match(/embedding\('model_id', \$1\)::vector/g),
    ).toHaveLength(1);
    expect(
      search.text.match(/SELECT embedding FROM __langchain_query_embedding/g),
    ).toHaveLength(2);
    expect(search.values).toEqual(["", 4]);
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it("keeps hybrid insertion and dense/sparse query parameters aligned", async () => {
    const pool = makePool();
    const embeddings = makeEmbeddings("template");
    const store = await PGVectorStore.initialize(
      PGEngine.fromPool(pool as unknown as Pool),
      embeddings,
      "docs",
      {
        metadataColumns: ["category"],
        hybridSearchConfig: new HybridSearchConfig({
          tsvColumn: "content_tsv",
          tsvLang: "english",
          primaryTopK: 7,
          secondaryTopK: 9,
        }),
      },
    );
    await store.addTexts([text], [{ category: "docs", extra: true }], ["id-1"]);
    const insert = pool.calls.find((call) =>
      call.text.startsWith("INSERT INTO"),
    )!;
    expect(insert.text).toContain(
      "embedding('model_id', $2)::vector, to_tsvector('english', $3), $4, $5",
    );
    expect(insert.values).toEqual([
      "id-1",
      text,
      text,
      "docs",
      '{"extra":true}',
    ]);

    await store.similaritySearchWithScore(text, 2, { category: "docs" });
    const searches = pool.calls.filter((call) =>
      call.text.includes("as distance"),
    );
    expect(searches).toHaveLength(2);
    expect(searches[0].values).toEqual(["docs", text, 7]);
    expect(searches[1].values).toEqual(["docs", text, 9]);
    expect(searches[1].text).toContain("plainto_tsquery('english', $2)");
    expect(searches.every((call) => !call.text.includes(text))).toBe(true);
  });

  it.each([false, true])(
    "falls back to client embeddings when hooks are not callable (%s)",
    async (nonCallable) => {
      const pool = makePool();
      const embeddings = new FakeEmbeddings(2);
      if (nonCallable)
        Object.assign(embeddings, {
          embedQueryInlineTemplate: "not a function",
          embedQueryInline: true,
        });
      const embedDocuments = vi.spyOn(embeddings, "embedDocuments");
      const embedQuery = vi.spyOn(embeddings, "embedQuery");
      const store = await PGVectorStore.initialize(
        PGEngine.fromPool(pool as unknown as Pool),
        embeddings,
        "docs",
      );
      await store.addTexts([text], undefined, ["id-1"]);
      await store.similaritySearchWithScore(text, 3);
      expect(embedDocuments).toHaveBeenCalledWith([text]);
      expect(embedQuery).toHaveBeenCalledWith(text);
      const vector = JSON.stringify(await embeddings.embedQuery(text));
      const insert = pool.calls.find((call) =>
        call.text.startsWith("INSERT INTO"),
      )!;
      expect(insert.values).toEqual(["id-1", text, vector, "{}"]);
      const search = pool.calls.find((call) =>
        call.text.includes("as distance"),
      )!;
      expect(search.values).toEqual([vector, 3]);
    },
  );

  it("supports an inline provider supplied as a typed object literal", async () => {
    const pool = makePool();
    const embeddings: PGVectorStoreEmbeddings = {
      embedDocuments: vi.fn(async () => []),
      embedQuery: vi.fn(async () => []),
      embedQueryInlineTemplate: (placeholder) =>
        `embedding('model_id', ${placeholder})::vector`,
    };
    const store = await PGVectorStore.initialize(
      PGEngine.fromPool(pool as unknown as Pool),
      embeddings,
      "docs",
      { metadataJsonColumn: null },
    );
    await store.addTexts([text], undefined, ["id-1"]);
    const insert = pool.calls.find((call) =>
      call.text.startsWith("INSERT INTO"),
    )!;
    expect(insert.text).toContain(
      "VALUES ($1, $2::text, embedding('model_id', $2)::vector)",
    );
    expect(insert.values).toEqual(["id-1", text]);
  });
});
