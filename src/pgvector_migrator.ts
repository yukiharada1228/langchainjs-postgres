/**
 * Utilities for migrating data from the legacy {@link PGVector} store
 * (the single `langchain_pg_collection` / `langchain_pg_embedding` tables)
 * into a per-table {@link PGVectorStore}.
 *
 * Ported from `langchain_postgres.utils.pgvector_migrator` (Python). The
 * Python version inserts concurrently (up to 100 in flight) via asyncio;
 * this port inserts batch-by-batch sequentially instead, trading some
 * throughput for a smaller dependency surface and simpler error handling.
 */
import { Document } from "@langchain/core/documents";

import type { PGEngine } from "./engine.js";
import type { PGVectorStore } from "./vectorstore.js";

export const COLLECTIONS_TABLE = "langchain_pg_collection";
export const EMBEDDINGS_TABLE = "langchain_pg_embedding";

export interface PgVectorRow {
  id: string;
  collection_id: string;
  embedding: string;
  document: string;
  cmetadata: Record<string, any> | null;
}

async function getCollectionUuid(
  engine: PGEngine,
  collectionName: string,
): Promise<string> {
  const result = await engine.pool.query(
    `SELECT uuid FROM ${COLLECTIONS_TABLE} WHERE name = $1`,
    [collectionName],
  );
  if (result.rows.length === 0) {
    throw new Error(`Collection, ${collectionName} not found.`);
  }
  return result.rows[0].uuid;
}

/** Extract all data belonging to a legacy `PGVector` collection, in batches. */
export async function* extractPgvectorCollection(
  engine: PGEngine,
  collectionName: string,
  batchSize = 1000,
): AsyncGenerator<PgVectorRow[]> {
  const uuid = await getCollectionUuid(engine, collectionName);
  let offset = 0;
  for (;;) {
    const result = await engine.pool.query(
      `SELECT * FROM ${EMBEDDINGS_TABLE} WHERE collection_id = $1 ORDER BY id LIMIT $2 OFFSET $3`,
      [uuid, batchSize, offset],
    );
    if (result.rows.length === 0) break;
    yield result.rows;
    offset += result.rows.length;
    if (result.rows.length < batchSize) break;
  }
}

/** List all collection names present in the legacy `PGVector` collection table. */
export async function listPgvectorCollectionNames(
  engine: PGEngine,
): Promise<string[]> {
  const result = await engine.pool.query(
    `SELECT name FROM ${COLLECTIONS_TABLE}`,
  );
  return result.rows.map((row: { name: string }) => row.name);
}

export interface MigratePgvectorCollectionOptions {
  /** Delete the original legacy collection data upon successful migration. Default: `false`. */
  deletePgCollection?: boolean;
  /** Number of rows to read/insert per batch. Default: `1000`. */
  insertBatchSize?: number;
}

/**
 * Migrate all data present in a legacy `PGVector` collection into a
 * {@link PGVectorStore} table.
 */
export async function migratePgvectorCollection(
  engine: PGEngine,
  collectionName: string,
  vectorStore: PGVectorStore,
  options: MigratePgvectorCollectionOptions = {},
): Promise<void> {
  const insertBatchSize = options.insertBatchSize ?? 1000;
  const uuid = await getCollectionUuid(engine, collectionName);

  const countResult = await engine.pool.query(
    `SELECT COUNT(*) FROM ${EMBEDDINGS_TABLE} WHERE collection_id = $1`,
    [uuid],
  );
  const originalCount = Number(countResult.rows[0].count);
  if (originalCount === 0) {
    console.warn(`Collection, ${collectionName} contains no elements.`);
    return;
  }

  for await (const batch of extractPgvectorCollection(
    engine,
    collectionName,
    insertBatchSize,
  )) {
    const embeddings = batch.map(
      (row) => JSON.parse(row.embedding) as number[],
    );
    const documents = batch.map(
      (row) =>
        new Document({
          pageContent: row.document,
          metadata: row.cmetadata ?? {},
        }),
    );
    const ids = batch.map((row) => row.id);
    await vectorStore.addVectors(embeddings, documents, { ids });
  }

  const destResult = await engine.pool.query(
    `SELECT COUNT(*) FROM "${vectorStore.schemaName}"."${vectorStore.tableName}"`,
  );
  const destCount = Number(destResult.rows[0].count);
  if (destCount !== originalCount) {
    throw new Error(
      "All data not yet migrated.\n" +
        `Original row count: ${originalCount}\n` +
        `Collection table, ${vectorStore.tableName} row count: ${destCount}`,
    );
  }

  if (options.deletePgCollection) {
    await engine.pool.query(
      `DELETE FROM ${EMBEDDINGS_TABLE} WHERE collection_id = $1`,
      [uuid],
    );
    await engine.pool.query(
      `DELETE FROM ${COLLECTIONS_TABLE} WHERE name = $1`,
      [collectionName],
    );
    console.log(`Successfully deleted PGVector collection, ${collectionName}`);
  }
}
