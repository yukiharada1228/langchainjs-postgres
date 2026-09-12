/**
 * Legacy Postgres vector store using a collection/embedding table pair.
 *
 * Ported from `langchain_postgres.vectorstores.PGVector` (Python). The
 * upstream class builds its own SQLAlchemy engine directly from a connection
 * string; this port instead takes a {@link PGEngine} (the same connection
 * pool abstraction used by {@link PGVectorStore}) so both stores in this
 * package share one connection-management story. The on-disk schema
 * (`langchain_pg_collection` / `langchain_pg_embedding`) and filter
 * semantics are preserved.
 */
import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { maximalMarginalRelevance } from "@langchain/core/utils/math";
import {
  VectorStore,
  type MaxMarginalRelevanceSearchOptions,
} from "@langchain/core/vectorstores";
import { v4 as uuidv4 } from "uuid";

import { ParamBuilder } from "../filter.js";
import type { Row } from "../hybrid_search.js";
import type { PGEngine } from "../engine.js";
import { createLegacyFilterClause } from "./filter.js";

/** Enumerator of the distance strategies supported by the legacy store. */
export const LegacyDistanceStrategy = {
  EUCLIDEAN: "l2",
  COSINE: "cosine",
  MAX_INNER_PRODUCT: "inner",
} as const;

export type LegacyDistanceStrategy =
  (typeof LegacyDistanceStrategy)[keyof typeof LegacyDistanceStrategy];

const DEFAULT_COLLECTION_NAME = "langchain";

function vectorToSql(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function distanceOperator(strategy: LegacyDistanceStrategy): string {
  switch (strategy) {
    case LegacyDistanceStrategy.EUCLIDEAN:
      return "<->";
    case LegacyDistanceStrategy.MAX_INNER_PRODUCT:
      return "<#>";
    case LegacyDistanceStrategy.COSINE:
    default:
      return "<=>";
  }
}

export interface PGVectorInitializeOptions {
  collectionName?: string;
  collectionMetadata?: Record<string, any>;
  distanceStrategy?: LegacyDistanceStrategy;
  /** Delete the collection (if it already exists) before (re)creating it. */
  preDeleteCollection?: boolean;
}

export interface PGVectorFromTextsOptions extends PGVectorInitializeOptions {
  engine: PGEngine;
  ids?: string[];
}

interface PGVectorArgs {
  engine: PGEngine;
  collectionName: string;
  collectionMetadata?: Record<string, any>;
  distanceStrategy: LegacyDistanceStrategy;
  preDeleteCollection: boolean;
}

/** Legacy Postgres vector store backed by the `pgvector` extension. */
export class PGVector extends VectorStore {
  declare FilterType: Record<string, any>;

  engine: PGEngine;
  collectionName: string;
  collectionMetadata?: Record<string, any>;
  distanceStrategy: LegacyDistanceStrategy;
  preDeleteCollection: boolean;

  private collectionId?: string;

  private constructor(embeddings: EmbeddingsInterface, args: PGVectorArgs) {
    super(embeddings, {});
    this.engine = args.engine;
    this.collectionName = args.collectionName;
    this.collectionMetadata = args.collectionMetadata;
    this.distanceStrategy = args.distanceStrategy;
    this.preDeleteCollection = args.preDeleteCollection;
  }

  _vectorstoreType(): string {
    return "pgvector";
  }

  static async initialize(
    engine: PGEngine,
    embeddings: EmbeddingsInterface,
    options: PGVectorInitializeOptions = {},
  ): Promise<PGVector> {
    const store = new PGVector(embeddings, {
      engine,
      collectionName: options.collectionName ?? DEFAULT_COLLECTION_NAME,
      collectionMetadata: options.collectionMetadata,
      distanceStrategy:
        options.distanceStrategy ?? LegacyDistanceStrategy.COSINE,
      preDeleteCollection: options.preDeleteCollection ?? false,
    });
    await store.createTablesIfNotExists();
    await store.createCollection();
    return store;
  }

  static async fromTexts(
    texts: string[],
    metadatas: Record<string, any>[] | Record<string, any>,
    embeddings: EmbeddingsInterface,
    dbConfig: PGVectorFromTextsOptions,
  ): Promise<PGVector> {
    const { engine, ids, ...options } = dbConfig;
    const store = await PGVector.initialize(engine, embeddings, options);
    const metadatasArray = Array.isArray(metadatas)
      ? metadatas
      : texts.map(() => metadatas);
    await store.addDocuments(
      texts.map(
        (text, i) =>
          new Document({
            pageContent: text,
            metadata: metadatasArray[i] ?? {},
          }),
      ),
      ids ? { ids } : undefined,
    );
    return store;
  }

  static async fromDocuments(
    docs: DocumentInterface[],
    embeddings: EmbeddingsInterface,
    dbConfig: PGVectorFromTextsOptions,
  ): Promise<PGVector> {
    const { engine, ids, ...options } = dbConfig;
    const store = await PGVector.initialize(engine, embeddings, options);
    await store.addDocuments(docs, ids ? { ids } : undefined);
    return store;
  }

  private async createTablesIfNotExists(): Promise<void> {
    await this.engine.pool.query(
      "SELECT pg_advisory_xact_lock(1573678846307946496); CREATE EXTENSION IF NOT EXISTS vector;",
    );
    await this.engine.pool.query(`
      CREATE TABLE IF NOT EXISTS langchain_pg_collection (
        uuid UUID PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        cmetadata JSON
      );
    `);
    await this.engine.pool.query(`
      CREATE TABLE IF NOT EXISTS langchain_pg_embedding (
        id VARCHAR PRIMARY KEY,
        collection_id UUID REFERENCES langchain_pg_collection(uuid) ON DELETE CASCADE,
        embedding vector,
        document VARCHAR,
        cmetadata JSONB
      );
    `);
    await this.engine.pool.query(`
      CREATE INDEX IF NOT EXISTS ix_cmetadata_gin
        ON langchain_pg_embedding USING gin (cmetadata jsonb_path_ops);
    `);
  }

  /** Delete the collection (its row and all embeddings, via `ON DELETE CASCADE`). */
  async deleteCollection(): Promise<void> {
    await this.engine.pool.query(
      "DELETE FROM langchain_pg_collection WHERE name = $1",
      [this.collectionName],
    );
    this.collectionId = undefined;
  }

  private async createCollection(): Promise<void> {
    if (this.preDeleteCollection) await this.deleteCollection();

    const existing = await this.engine.pool.query(
      "SELECT uuid FROM langchain_pg_collection WHERE name = $1",
      [this.collectionName],
    );
    if (existing.rows.length > 0) {
      this.collectionId = existing.rows[0].uuid;
      return;
    }

    const id = uuidv4();
    await this.engine.pool.query(
      "INSERT INTO langchain_pg_collection (uuid, name, cmetadata) VALUES ($1, $2, $3)",
      [
        id,
        this.collectionName,
        this.collectionMetadata
          ? JSON.stringify(this.collectionMetadata)
          : null,
      ],
    );
    this.collectionId = id;
  }

  private requireCollectionId(): string {
    if (!this.collectionId) {
      throw new Error(
        "Collection not initialized. Use PGVector.initialize(...) rather than constructing directly.",
      );
    }
    return this.collectionId;
  }

  private rowToDocument(row: Row): Document {
    return new Document({
      pageContent: row.document,
      metadata: row.cmetadata ?? {},
      id: String(row.id),
    });
  }

  private async addEmbeddings(
    texts: string[],
    embeddings: number[][],
    metadatas?: Record<string, any>[],
    ids?: Array<string | null | undefined>,
  ): Promise<string[]> {
    const collectionId = this.requireCollectionId();
    const finalIds = texts.map((_, i) => ids?.[i] ?? uuidv4());
    const finalMetadatas: Record<string, any>[] =
      metadatas && metadatas.length === texts.length
        ? metadatas
        : texts.map(() => ({}));

    const client = await this.engine.pool.connect();
    try {
      for (let i = 0; i < texts.length; i += 1) {
        await client.query(
          `INSERT INTO langchain_pg_embedding (id, collection_id, embedding, document, cmetadata)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             collection_id = EXCLUDED.collection_id,
             embedding = EXCLUDED.embedding,
             document = EXCLUDED.document,
             cmetadata = EXCLUDED.cmetadata;`,
          [
            finalIds[i],
            collectionId,
            vectorToSql(embeddings[i]),
            texts[i],
            JSON.stringify(finalMetadatas[i] ?? {}),
          ],
        );
      }
    } finally {
      client.release();
    }

    return finalIds;
  }

  async addVectors(
    vectors: number[][],
    documents: DocumentInterface[],
    options?: Record<string, any>,
  ): Promise<string[]> {
    const texts = documents.map((d) => d.pageContent);
    const metadatas = documents.map((d) => d.metadata ?? {});
    const ids: Array<string | null | undefined> | undefined =
      options?.ids ?? documents.map((d) => d.id);
    return this.addEmbeddings(texts, vectors, metadatas, ids);
  }

  async addDocuments(
    documents: DocumentInterface[],
    options?: Record<string, any>,
  ): Promise<string[]> {
    const texts = documents.map((d) => d.pageContent);
    const embeddings = await this.embeddings.embedDocuments(texts);
    return this.addVectors(embeddings, documents, options);
  }

  async addTexts(
    texts: string[],
    metadatas?: Record<string, any>[],
    ids?: Array<string | null | undefined>,
  ): Promise<string[]> {
    const embeddings = await this.embeddings.embedDocuments(texts);
    return this.addEmbeddings(texts, embeddings, metadatas, ids);
  }

  async delete(
    params: { ids?: string[]; filter?: Record<string, any> } = {},
  ): Promise<void> {
    const collectionId = this.requireCollectionId();
    const { ids, filter } = params;
    const paramBuilder = new ParamBuilder();
    const collectionPlaceholder = paramBuilder.add(collectionId);
    const clauses = [`collection_id = ${collectionPlaceholder}`];

    if (ids?.length) {
      const placeholders = ids.map((id) => paramBuilder.add(id));
      clauses.push(`id IN (${placeholders.join(", ")})`);
    }
    if (filter) {
      clauses.push(createLegacyFilterClause(filter, paramBuilder));
    }

    await this.engine.pool.query(
      `DELETE FROM langchain_pg_embedding WHERE ${clauses.join(" AND ")}`,
      paramBuilder.values,
    );
  }

  private async queryCollection(
    embedding: number[],
    k: number,
    filter?: Record<string, any>,
  ): Promise<Row[]> {
    const collectionId = this.requireCollectionId();
    const operator = distanceOperator(this.distanceStrategy);

    const params = new ParamBuilder();
    const collectionPlaceholder = params.add(collectionId);
    const clauses = [`collection_id = ${collectionPlaceholder}`];
    if (filter) {
      clauses.push(createLegacyFilterClause(filter, params));
    }
    const embeddingPlaceholder = params.add(vectorToSql(embedding));
    const limitPlaceholder = params.add(k);

    const query = `SELECT id, document, cmetadata, embedding, embedding ${operator} ${embeddingPlaceholder} AS distance
      FROM langchain_pg_embedding
      WHERE ${clauses.join(" AND ")}
      ORDER BY embedding ${operator} ${embeddingPlaceholder}
      LIMIT ${limitPlaceholder};`;

    const result = await this.engine.pool.query(query, params.values);
    return result.rows;
  }

  async similaritySearchVectorWithScore(
    embedding: number[],
    k: number,
    filter?: Record<string, any>,
  ): Promise<[Document, number][]> {
    const rows = await this.queryCollection(embedding, k, filter);
    return rows.map((row) => [this.rowToDocument(row), Number(row.distance)]);
  }

  async maxMarginalRelevanceSearch(
    query: string,
    options: MaxMarginalRelevanceSearchOptions<this["FilterType"]>,
  ): Promise<Document[]> {
    const embedding = await this.embeddings.embedQuery(query);
    const results = await this.maxMarginalRelevanceSearchWithScoreByVector(
      embedding,
      options,
    );
    return results.map(([doc]) => doc);
  }

  async maxMarginalRelevanceSearchWithScoreByVector(
    embedding: number[],
    options: {
      k?: number;
      fetchK?: number;
      lambda?: number;
      filter?: Record<string, any>;
    } = {},
  ): Promise<[Document, number][]> {
    const fetchK = options.fetchK ?? 20;
    const k = options.k ?? 4;
    const lambdaMult = options.lambda ?? 0.5;

    const rows = await this.queryCollection(embedding, fetchK, options.filter);
    const embeddingList = rows.map(
      (row) => JSON.parse(row.embedding) as number[],
    );
    const selected = new Set(
      maximalMarginalRelevance(embedding, embeddingList, lambdaMult, k),
    );

    return rows
      .map((row): [Document, number] => [
        this.rowToDocument(row),
        Number(row.distance),
      ])
      .filter((_, i) => selected.has(i));
  }

  async getByIds(ids: string[]): Promise<Document[]> {
    const collectionId = this.requireCollectionId();
    const params = new ParamBuilder();
    const collectionPlaceholder = params.add(collectionId);
    const placeholders = ids.map((id) => params.add(id));
    const query = `SELECT id, document, cmetadata FROM langchain_pg_embedding
      WHERE collection_id = ${collectionPlaceholder} AND id IN (${placeholders.join(", ")});`;
    const result = await this.engine.pool.query(query, params.values);
    return result.rows.map((row: Row) => this.rowToDocument(row));
  }
}
