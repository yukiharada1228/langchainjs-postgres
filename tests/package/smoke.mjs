/* global process, console */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";

const require = createRequire(import.meta.url);
const mode = process.argv[2] ?? "esm";
assert.ok(["esm", "cjs"].includes(mode), "Expected esm or cjs");
const lib =
  mode === "cjs"
    ? require("@yukiharada1228/langchain-postgres")
    : await import("@yukiharada1228/langchain-postgres");
const {
  PGEngine,
  PGVectorStore,
  PGVector,
  HNSWIndex,
  PostgresChatMessageHistory,
} = lib;
for (const value of [
  PGEngine,
  PGVectorStore,
  HNSWIndex,
  PostgresChatMessageHistory,
]) {
  assert.equal(typeof value, "function");
}
async function verifyDatabase() {
  const suffix = randomUUID().replaceAll("-", "");
  const collectionName = `pkg_legacy_${suffix}`;
  let legacy;
  const table = `pkg_vectors_${suffix}`;
  const chatTable = `pkg_chat_${suffix}`;
  const engine = PGEngine.fromConnectionString(process.env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const vectorFor = (text) =>
    text.includes("database") ? [1, 0, 0] : [0, 1, 0];
  const embeddings = {
    embedDocuments: async (texts) => texts.map(vectorFor),
    embedQuery: async (text) => vectorFor(text),
  };
  try {
    await engine.initVectorstoreTable(table, 3, {
      metadataColumns: [{ name: "category", dataType: "TEXT" }],
    });
    const store = await PGVectorStore.initialize(engine, embeddings, table, {
      metadataColumns: ["category"],
    });
    const ids = await store.addDocuments([
      { pageContent: "database document", metadata: { category: "db" } },
      { pageContent: "cat document", metadata: { category: "animal" } },
    ]);
    assert.equal(ids.length, 2);
    for (const id of ids)
      assert.match(
        id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    assert.notEqual(ids[0], ids[1]);
    assert.equal(
      (await store.similaritySearch("database", 1))[0].pageContent,
      "database document",
    );
    assert.equal(
      (await store.similaritySearch("cat", 2, { category: "animal" }))[0]
        .pageContent,
      "cat document",
    );
    assert.equal((await store.getByIds(ids)).length, 2);
    await store.applyVectorIndex(new HNSWIndex({ m: 8, efConstruction: 32 }));
    assert.equal(await store.isValidIndex(), true);
    await store.dropVectorIndex();
    await store.delete({ ids: [ids[0]] });
    assert.equal((await store.getByIds([ids[0]])).length, 0);

    legacy = await PGVector.initialize(engine, embeddings, { collectionName });
    const legacyIds = await legacy.addDocuments([
      { pageContent: "legacy database", metadata: {} },
    ]);
    assert.match(
      legacyIds[0],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      (await legacy.similaritySearch("database", 1))[0].pageContent,
      "legacy database",
    );

    await PostgresChatMessageHistory.createTables(pool, chatTable);
    const history = new PostgresChatMessageHistory({
      tableName: chatTable,
      sessionId: randomUUID(),
      pool,
    });
    await history.addUserMessage("Hello");
    await history.addAIMessage("Hi");
    assert.deepEqual(
      (await history.getMessages()).map((message) => message.content),
      ["Hello", "Hi"],
    );
    await history.clear();
    assert.equal((await history.getMessages()).length, 0);
    console.log(
      JSON.stringify({
        node: process.version,
        mode,
        exports: Object.keys(lib).length,
        result:
          "PASS: packed package vector CRUD/search/filter/index and chat persistence",
      }),
    );
  } finally {
    await legacy?.deleteCollection();
    await PostgresChatMessageHistory.dropTable(pool, chatTable).catch(() => {});
    await engine.dropTable(table).catch(() => {});
    await engine.close();
    await pool.end();
  }
}
if (process.env.DATABASE_URL) {
  await verifyDatabase();
} else {
  console.log(
    `${process.version} ${mode}: package imports passed; DB checks skipped (set DATABASE_URL)`,
  );
}
