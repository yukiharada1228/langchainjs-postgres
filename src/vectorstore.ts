/**
 * Postgres-backed vector store built on top of {@link PGEngine}.
 *
 * Ported from `langchain_postgres.v2.async_vectorstore.AsyncPGVectorStore`
 * (Python). The upstream package ships separate sync/async classes
 * (`PGVectorStore` / `AsyncPGVectorStore`) because Python needs to bridge a
 * background event loop for synchronous callers. JavaScript has no such
 * split: every method here is simply async, matching how every other
 * LangChain.js vector store is implemented.
 */
import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { maximalMarginalRelevance } from "@langchain/core/utils/math";
import {
  VectorStore,
  type MaxMarginalRelevanceSearchOptions,
} from "@langchain/core/vectorstores";
import { v4 as uuidv4 } from "uuid";

import { PGEngine } from "./engine.js";
import {
  createFilterClause,
  ParamBuilder,
  type FilterContext,
} from "./filter.js";
import { HybridSearchConfig } from "./hybrid_search.js";
import type { Row } from "./hybrid_search.js";
import {
  BaseIndex,
  DEFAULT_DISTANCE_STRATEGY,
  DEFAULT_INDEX_NAME_SUFFIX,
  DistanceStrategy,
  ExactNearestNeighbor,
  QueryOptions,
} from "./indexes.js";

function vectorToSql(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Embeddings with optional database-side SQL expression hooks. */
export interface PGVectorStoreEmbeddings extends EmbeddingsInterface {
  /**
   * Return a trusted SQL expression using the supplied `$n` placeholder.
   * The store binds the document or query text separately. Preferred over
   * embedQueryInline when both hooks are available.
   */
  embedQueryInlineTemplate?(placeholder: string): string;
  /**
   * Legacy hook returning a complete SQL expression. The provider is
   * responsible for escaping the text; prefer embedQueryInlineTemplate.
   */
  embedQueryInline?(text: string): string;
}

export interface PGVectorStoreInitializeOptions {
  schemaName?: string;
  contentColumn?: string;
  embeddingColumn?: string;
  metadataColumns?: string[];
  ignoreMetadataColumns?: string[];
  idColumn?: string;
  /** Pass `null` to disable the metadata JSON column entirely. */
  metadataJsonColumn?: string | null;
  distanceStrategy?: DistanceStrategy;
  k?: number;
  fetchK?: number;
  lambdaMult?: number;
  indexQueryOptions?: QueryOptions;
  hybridSearchConfig?: HybridSearchConfig;
}

export interface PGVectorStoreFromTextsOptions extends PGVectorStoreInitializeOptions {
  engine: PGEngine;
  tableName: string;
  ids?: string[];
}

interface PGVectorStoreArgs {
  engine: PGEngine;
  tableName: string;
  schemaName: string;
  contentColumn: string;
  embeddingColumn: string;
  metadataColumns: string[];
  idColumn: string;
  metadataJsonColumn?: string;
  distanceStrategy: DistanceStrategy;
  k: number;
  fetchK: number;
  lambdaMult: number;
  indexQueryOptions?: QueryOptions;
  hybridSearchConfig?: HybridSearchConfig;
}

export interface PGVectorStoreGetOptions {
  ids?: string[];
  where?: Record<string, any>;
  limit?: number;
  offset?: number;
  whereDocument?: Record<string, any>;
  include?: Array<"embeddings" | "metadatas" | "documents">;
}

export interface PGVectorStoreGetResult {
  ids: string[];
  embeddings?: number[][];
  metadatas?: Record<string, any>[];
  documents?: string[];
}

export interface MMRByVectorOptions {
  k?: number;
  fetchK?: number;
  lambda?: number;
  filter?: Record<string, any>;
}

/** Postgres vector store backed by the `pgvector` extension. */
export class PGVectorStore extends VectorStore {
  declare FilterType: Record<string, any>;
  declare embeddings: PGVectorStoreEmbeddings;

  engine: PGEngine;
  tableName: string;
  schemaName: string;
  contentColumn: string;
  embeddingColumn: string;
  metadataColumns: string[];
  idColumn: string;
  metadataJsonColumn?: string;
  distanceStrategy: DistanceStrategy;
  k: number;
  fetchK: number;
  lambdaMult: number;
  indexQueryOptions?: QueryOptions;
  hybridSearchConfig?: HybridSearchConfig;

  private constructor(
    embeddings: PGVectorStoreEmbeddings,
    args: PGVectorStoreArgs,
  ) {
    super(embeddings, {});
    this.engine = args.engine;
    this.tableName = args.tableName;
    this.schemaName = args.schemaName;
    this.contentColumn = args.contentColumn;
    this.embeddingColumn = args.embeddingColumn;
    this.metadataColumns = args.metadataColumns;
    this.idColumn = args.idColumn;
    this.metadataJsonColumn = args.metadataJsonColumn;
    this.distanceStrategy = args.distanceStrategy;
    this.k = args.k;
    this.fetchK = args.fetchK;
    this.lambdaMult = args.lambdaMult;
    this.indexQueryOptions = args.indexQueryOptions;
    this.hybridSearchConfig = args.hybridSearchConfig;
  }

  _vectorstoreType(): string {
    return "pgvector";
  }

  /**
   * Create a {@link PGVectorStore} bound to an existing table.
   * Use {@link PGEngine.initVectorstoreTable} first to create the table.
   */
  static async initialize(
    engine: PGEngine,
    embeddings: PGVectorStoreEmbeddings,
    tableName: string,
    options: PGVectorStoreInitializeOptions = {},
  ): Promise<PGVectorStore> {
    let metadataColumns = options.metadataColumns ?? [];
    if (metadataColumns.length && options.ignoreMetadataColumns?.length) {
      throw new Error(
        "Can not use both metadataColumns and ignoreMetadataColumns.",
      );
    }

    const schemaName = options.schemaName ?? "public";
    const idColumn = options.idColumn ?? "langchain_id";
    const contentColumn = options.contentColumn ?? "content";
    const embeddingColumn = options.embeddingColumn ?? "embedding";

    const { rows } = await engine.pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2",
      [tableName, schemaName],
    );
    const columns = new Map<string, string>(
      rows.map((row: { column_name: string; data_type: string }) => [
        row.column_name,
        row.data_type,
      ]),
    );

    if (!columns.has(idColumn)) {
      throw new Error(`Id column, ${idColumn}, does not exist.`);
    }
    if (!columns.has(contentColumn)) {
      throw new Error(`Content column, ${contentColumn}, does not exist.`);
    }
    const contentType = columns.get(contentColumn)!;
    if (contentType !== "text" && !contentType.includes("char")) {
      throw new Error(
        `Content column, ${contentColumn}, is type, ${contentType}. It must be a type of character string.`,
      );
    }

    const hybridSearchConfig = options.hybridSearchConfig;
    if (hybridSearchConfig) {
      const tsvColumnName =
        hybridSearchConfig.tsvColumn || `${contentColumn}_tsv`;
      if (columns.get(tsvColumnName) !== "tsvector") {
        hybridSearchConfig.tsvColumn = "";
      }
    }

    if (!columns.has(embeddingColumn)) {
      throw new Error(`Embedding column, ${embeddingColumn}, does not exist.`);
    }
    const embeddingType = columns.get(embeddingColumn)!;
    if (!["USER-DEFINED", "vector"].includes(embeddingType)) {
      throw new Error(
        `Embedding column, ${embeddingColumn}, is not type Vector.`,
      );
    }

    let metadataJsonColumn: string | undefined =
      options.metadataJsonColumn === null
        ? undefined
        : (options.metadataJsonColumn ?? "langchain_metadata");
    if (metadataJsonColumn && !columns.has(metadataJsonColumn)) {
      metadataJsonColumn = undefined;
    }

    for (const column of metadataColumns) {
      if (!columns.has(column)) {
        throw new Error(`Metadata column, ${column}, does not exist.`);
      }
    }

    if (options.ignoreMetadataColumns?.length) {
      const ignored = new Set([
        ...options.ignoreMetadataColumns,
        idColumn,
        contentColumn,
        embeddingColumn,
      ]);
      metadataColumns = [...columns.keys()].filter((c) => !ignored.has(c));
    }

    return new PGVectorStore(embeddings, {
      engine,
      tableName,
      schemaName,
      contentColumn,
      embeddingColumn,
      metadataColumns,
      idColumn,
      metadataJsonColumn,
      distanceStrategy: options.distanceStrategy ?? DEFAULT_DISTANCE_STRATEGY,
      k: options.k ?? 4,
      fetchK: options.fetchK ?? 20,
      lambdaMult: options.lambdaMult ?? 0.5,
      indexQueryOptions: options.indexQueryOptions,
      hybridSearchConfig,
    });
  }

  static async fromTexts(
    texts: string[],
    metadatas: Record<string, any>[] | Record<string, any>,
    embeddings: PGVectorStoreEmbeddings,
    dbConfig: PGVectorStoreFromTextsOptions,
  ): Promise<PGVectorStore> {
    const { engine, tableName, ids, ...options } = dbConfig;
    const store = await PGVectorStore.initialize(
      engine,
      embeddings,
      tableName,
      options,
    );
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
    embeddings: PGVectorStoreEmbeddings,
    dbConfig: PGVectorStoreFromTextsOptions,
  ): Promise<PGVectorStore> {
    const { engine, tableName, ids, ...options } = dbConfig;
    const store = await PGVectorStore.initialize(
      engine,
      embeddings,
      tableName,
      options,
    );
    await store.addDocuments(docs, ids ? { ids } : undefined);
    return store;
  }

  private filterContext(params: ParamBuilder): FilterContext {
    return {
      metadataJsonColumn: this.metadataJsonColumn,
      metadataColumns: this.metadataColumns,
      idColumn: this.idColumn,
      contentColumn: this.contentColumn,
      embeddingColumn: this.embeddingColumn,
      params,
    };
  }

  private rowToDocument(row: Row): Document {
    const metadata: Record<string, any> =
      (this.metadataJsonColumn ? row[this.metadataJsonColumn] : undefined) ??
      {};
    for (const col of this.metadataColumns) metadata[col] = row[col];
    return new Document({
      pageContent: row[this.contentColumn],
      metadata,
      id: String(row[this.idColumn]),
    });
  }

  private async addEmbeddings(
    texts: string[],
    embeddings: number[][],
    metadatas?: Record<string, any>[],
    ids?: Array<string | null | undefined>,
  ): Promise<string[]> {
    const finalIds = texts.map((_, i) => ids?.[i] ?? uuidv4());
    const finalMetadatas: Record<string, any>[] =
      metadatas && metadatas.length === texts.length
        ? metadatas
        : texts.map(() => ({}));

    const client = await this.engine.pool.connect();
    try {
      for (let i = 0; i < texts.length; i += 1) {
        const id = finalIds[i];
        const content = texts[i];
        const embedding = embeddings[i];
        const metadata = { ...(finalMetadatas[i] ?? {}) };

        const columns: string[] = [
          this.idColumn,
          this.contentColumn,
          this.embeddingColumn,
        ];
        const values: unknown[] = [id, content];
        const valueExprs: string[] = ["$1", "$2"];
        if (
          embedding.length === 0 &&
          typeof this.embeddings.embedQueryInlineTemplate === "function"
        ) {
          // Fix the shared parameter's type before assigning it to a char or
          // varchar column and passing it to a text embedding function.
          valueExprs[1] = "$2::text";
          valueExprs.push(this.embeddings.embedQueryInlineTemplate("$2"));
        } else if (
          embedding.length === 0 &&
          typeof this.embeddings.embedQueryInline === "function"
        ) {
          valueExprs.push(this.embeddings.embedQueryInline(content));
        } else {
          values.push(vectorToSql(embedding));
          valueExprs.push("$3");
        }

        if (this.hybridSearchConfig?.tsvColumn) {
          columns.push(this.hybridSearchConfig.tsvColumn);
          values.push(content);
          const lang = this.hybridSearchConfig.tsvLang;
          valueExprs.push(
            lang
              ? `to_tsvector('${lang}', $${values.length})`
              : `to_tsvector($${values.length})`,
          );
        }

        for (const col of this.metadataColumns) {
          if (col in metadata) {
            const value = metadata[col];
            values.push(
              value !== null && typeof value === "object"
                ? JSON.stringify(value)
                : value,
            );
            columns.push(col);
            valueExprs.push(`$${values.length}`);
            delete metadata[col];
          }
        }

        if (this.metadataJsonColumn) {
          columns.push(this.metadataJsonColumn);
          values.push(JSON.stringify(metadata));
          valueExprs.push(`$${values.length}`);
        }

        const columnList = columns.map((c) => `"${c}"`).join(", ");
        const valuesList = valueExprs.join(", ");

        let upsert = `ON CONFLICT ("${this.idColumn}") DO UPDATE SET "${this.contentColumn}" = EXCLUDED."${this.contentColumn}", "${this.embeddingColumn}" = EXCLUDED."${this.embeddingColumn}"`;
        if (this.hybridSearchConfig?.tsvColumn) {
          upsert += `, "${this.hybridSearchConfig.tsvColumn}" = EXCLUDED."${this.hybridSearchConfig.tsvColumn}"`;
        }
        if (this.metadataJsonColumn) {
          upsert += `, "${this.metadataJsonColumn}" = EXCLUDED."${this.metadataJsonColumn}"`;
        }
        for (const col of this.metadataColumns) {
          upsert += `, "${col}" = EXCLUDED."${col}"`;
        }

        const query = `INSERT INTO "${this.schemaName}"."${this.tableName}" (${columnList}) VALUES (${valuesList}) ${upsert};`;
        await client.query(query, values);
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
    const embeddings = this.hasInlineEmbeddings()
      ? texts.map(() => [])
      : await this.embeddings.embedDocuments(texts);
    return this.addVectors(embeddings, documents, options);
  }

  /** Embed raw texts and add them to the table. */
  async addTexts(
    texts: string[],
    metadatas?: Record<string, any>[],
    ids?: Array<string | null | undefined>,
  ): Promise<string[]> {
    const embeddings = this.hasInlineEmbeddings()
      ? texts.map(() => [])
      : await this.embeddings.embedDocuments(texts);
    return this.addEmbeddings(texts, embeddings, metadatas, ids);
  }

  private hasInlineEmbeddings(): boolean {
    return (
      typeof this.embeddings.embedQueryInlineTemplate === "function" ||
      typeof this.embeddings.embedQueryInline === "function"
    );
  }

  async delete(
    params: { ids?: string[]; filter?: Record<string, any> } = {},
  ): Promise<void> {
    const { ids, filter } = params;
    if (!ids?.length && !filter) return;

    const paramBuilder = new ParamBuilder();
    const whereClauses: string[] = [];

    if (ids?.length) {
      const placeholders = ids.map((id) => paramBuilder.add(id));
      whereClauses.push(`"${this.idColumn}" IN (${placeholders.join(", ")})`);
    }
    if (filter) {
      whereClauses.push(
        createFilterClause(filter, this.filterContext(paramBuilder)),
      );
    }

    const query = `DELETE FROM "${this.schemaName}"."${this.tableName}" WHERE ${whereClauses.join(" AND ")}`;
    await this.engine.pool.query(query, paramBuilder.values);
  }

  private async queryCollection(
    embedding: number[],
    options: {
      k?: number;
      filter?: Record<string, any>;
      query?: string;
      ftsQuery?: string;
      hybridSearchConfig?: HybridSearchConfig;
    } = {},
  ): Promise<Row[]> {
    const hybridSearchConfig =
      options.hybridSearchConfig ?? this.hybridSearchConfig;
    const finalK = options.k ?? this.k;
    const denseLimit = hybridSearchConfig
      ? hybridSearchConfig.primaryTopK
      : finalK;

    const { operator, searchFunction } = this.distanceStrategy;

    const columns = [
      this.idColumn,
      this.contentColumn,
      this.embeddingColumn,
      ...this.metadataColumns,
    ];
    if (this.metadataJsonColumn) columns.push(this.metadataJsonColumn);
    const columnNames = columns.map((c) => `"${c}"`).join(", ");

    const params = new ParamBuilder();
    let whereFilters = "";
    if (options.filter) {
      const clause = createFilterClause(
        options.filter,
        this.filterContext(params),
      );
      if (clause) whereFilters = `WHERE ${clause}`;
    }

    let inlineEmbeddingExpression: string | undefined;
    if (
      embedding.length === 0 &&
      options.query !== undefined &&
      typeof this.embeddings.embedQueryInlineTemplate === "function"
    ) {
      inlineEmbeddingExpression = this.embeddings.embedQueryInlineTemplate(
        params.add(options.query),
      );
    } else if (
      embedding.length === 0 &&
      options.query !== undefined &&
      typeof this.embeddings.embedQueryInline === "function"
    ) {
      inlineEmbeddingExpression = this.embeddings.embedQueryInline(
        options.query,
      );
    }
    // Materialize database-side embeddings once, even for STABLE/VOLATILE
    // functions. Scalar references let pgvector use the result as an index
    // scan parameter without evaluating the embedding for each candidate row.
    const embeddingCte =
      inlineEmbeddingExpression !== undefined
        ? `WITH __langchain_query_embedding AS MATERIALIZED (SELECT ${inlineEmbeddingExpression} AS embedding) `
        : "";
    const embeddingExpression =
      inlineEmbeddingExpression !== undefined
        ? "(SELECT embedding FROM __langchain_query_embedding)"
        : params.add(vectorToSql(embedding));
    const denseLimitPlaceholder = params.add(denseLimit);

    const denseQuery = `${embeddingCte}SELECT ${columnNames}, ${searchFunction}("${this.embeddingColumn}", ${embeddingExpression}) as distance
      FROM "${this.schemaName}"."${this.tableName}" ${whereFilters}
      ORDER BY "${this.embeddingColumn}" ${operator} ${embeddingExpression} LIMIT ${denseLimitPlaceholder};`;

    let denseResults: Row[];
    const client = await this.engine.pool.connect();
    try {
      if (this.indexQueryOptions) {
        for (const option of this.indexQueryOptions.toParameter()) {
          await client.query(`SET LOCAL ${option};`);
        }
      }
      const result = await client.query(denseQuery, params.values);
      denseResults = result.rows;
    } finally {
      client.release();
    }

    const ftsQuery = hybridSearchConfig?.ftsQuery || options.ftsQuery || "";
    if (hybridSearchConfig && ftsQuery) {
      hybridSearchConfig.fusionFunctionParameters = {
        ...hybridSearchConfig.fusionFunctionParameters,
        fetchTopK: finalK,
      };

      const sparseParams = new ParamBuilder();
      let sparseWhere = "";
      if (options.filter) {
        const clause = createFilterClause(
          options.filter,
          this.filterContext(sparseParams),
        );
        if (clause) sparseWhere = `AND (${clause})`;
      }

      const lang = hybridSearchConfig.tsvLang;
      const ftsQueryPlaceholder = sparseParams.add(ftsQuery);
      const queryTsv = lang
        ? `plainto_tsquery('${lang}', ${ftsQueryPlaceholder})`
        : `plainto_tsquery(${ftsQueryPlaceholder})`;
      const contentTsv = hybridSearchConfig.tsvColumn
        ? `"${hybridSearchConfig.tsvColumn}"`
        : lang
          ? `to_tsvector('${lang}', "${this.contentColumn}")`
          : `to_tsvector("${this.contentColumn}")`;
      const secondaryLimitPlaceholder = sparseParams.add(
        hybridSearchConfig.secondaryTopK,
      );

      const sparseQuery = `SELECT ${columnNames}, ts_rank_cd(${contentTsv}, ${queryTsv}) as distance
        FROM "${this.schemaName}"."${this.tableName}"
        WHERE ${contentTsv} @@ ${queryTsv} ${sparseWhere}
        ORDER BY distance DESC LIMIT ${secondaryLimitPlaceholder};`;

      const sparseResult = await this.engine.pool.query(
        sparseQuery,
        sparseParams.values,
      );

      return hybridSearchConfig.fusionFunction(
        denseResults,
        sparseResult.rows,
        {
          ...hybridSearchConfig.fusionFunctionParameters,
          distanceStrategy: this.distanceStrategy,
        },
      ) as Row[];
    }

    return denseResults;
  }

  async similaritySearch(
    query: string,
    k?: number,
    filter?: Record<string, any>,
  ): Promise<Document[]> {
    const results = await this.similaritySearchWithScore(query, k, filter);
    return results.map(([doc]) => doc);
  }

  async similaritySearchWithScore(
    query: string,
    k?: number,
    filter?: Record<string, any>,
  ): Promise<[Document, number][]> {
    const embedding = this.hasInlineEmbeddings()
      ? []
      : await this.embeddings.embedQuery(query);
    if (this.hybridSearchConfig && !this.hybridSearchConfig.ftsQuery) {
      this.hybridSearchConfig.ftsQuery = query;
    }
    return this.similaritySearchVectorWithScoreInternal(
      embedding,
      k,
      filter,
      query,
    );
  }

  async similaritySearchByVector(
    embedding: number[],
    k?: number,
    filter?: Record<string, any>,
  ): Promise<Document[]> {
    const results = await this.similaritySearchVectorWithScore(
      embedding,
      k ?? this.k,
      filter,
    );
    return results.map(([doc]) => doc);
  }

  async similaritySearchVectorWithScore(
    embedding: number[],
    k: number,
    filter?: Record<string, any>,
  ): Promise<[Document, number][]> {
    return this.similaritySearchVectorWithScoreInternal(embedding, k, filter);
  }

  private async similaritySearchVectorWithScoreInternal(
    embedding: number[],
    k?: number,
    filter?: Record<string, any>,
    query?: string,
  ): Promise<[Document, number][]> {
    const rows = await this.queryCollection(embedding, {
      k,
      filter,
      query,
      ftsQuery: query,
    });
    return rows.map((row) => [this.rowToDocument(row), Number(row.distance)]);
  }

  async maxMarginalRelevanceSearch(
    query: string,
    options: MaxMarginalRelevanceSearchOptions<this["FilterType"]>,
  ): Promise<Document[]> {
    const embedding = await this.embeddings.embedQuery(query);
    return this.maxMarginalRelevanceSearchByVector(embedding, {
      k: options.k,
      fetchK: options.fetchK,
      lambda: options.lambda,
      filter: options.filter,
    });
  }

  async maxMarginalRelevanceSearchByVector(
    embedding: number[],
    options: MMRByVectorOptions = {},
  ): Promise<Document[]> {
    const results = await this.maxMarginalRelevanceSearchWithScoreByVector(
      embedding,
      options,
    );
    return results.map(([doc]) => doc);
  }

  async maxMarginalRelevanceSearchWithScoreByVector(
    embedding: number[],
    options: MMRByVectorOptions = {},
  ): Promise<[Document, number][]> {
    const fetchK = options.fetchK ?? this.fetchK;
    const k = options.k ?? this.k;
    const lambdaMult = options.lambda ?? this.lambdaMult;

    const rows = await this.queryCollection(embedding, {
      k: fetchK,
      filter: options.filter,
    });
    const embeddingList = rows.map(
      (row) => JSON.parse(row[this.embeddingColumn]) as number[],
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

  /** Create a full-text-search (TSV) index for hybrid search. */
  async applyHybridSearchIndex(concurrently = false): Promise<void> {
    const cfg = this.hybridSearchConfig;
    if (!cfg || !cfg.indexType || !cfg.indexName) {
      throw new Error("Hybrid Search Config cannot create index.");
    }
    const lang = cfg.tsvLang;
    const tsvColumnName =
      cfg.tsvColumn ||
      (lang
        ? `to_tsvector('${lang}', ${this.contentColumn})`
        : `to_tsvector(${this.contentColumn})`);
    const query = `CREATE INDEX ${concurrently ? "CONCURRENTLY" : ""} ${cfg.indexName} ON "${this.schemaName}"."${this.tableName}" USING ${cfg.indexType}(${tsvColumnName});`;
    await this.engine.pool.query(query);
  }

  /** Create a vector index on the embedding column. Pass an {@link ExactNearestNeighbor} to drop the index instead. */
  async applyVectorIndex(
    index: BaseIndex,
    name?: string,
    options: { concurrently?: boolean } = {},
  ): Promise<void> {
    if (index instanceof ExactNearestNeighbor) {
      await this.dropVectorIndex();
      return;
    }

    if (index.extensionName) {
      await this.engine.pool.query(
        `CREATE EXTENSION IF NOT EXISTS ${index.extensionName}`,
      );
    }

    const indexFunction = index.getIndexFunction();
    const filterClause = index.partialIndexes?.length
      ? `WHERE (${index.partialIndexes.join(" AND ")})`
      : "";
    const withOptions = `WITH ${index.indexOptions()}`;
    const indexName =
      name ?? index.name ?? `${this.tableName}${DEFAULT_INDEX_NAME_SUFFIX}`;
    index.name ??= indexName;

    const stmt = `CREATE INDEX ${options.concurrently ? "CONCURRENTLY" : ""} "${indexName}" ON "${this.schemaName}"."${this.tableName}" USING ${index.indexType} ("${this.embeddingColumn}" ${indexFunction}) ${withOptions} ${filterClause};`;
    await this.engine.pool.query(stmt);
  }

  async reindex(indexName?: string): Promise<void> {
    const name = indexName ?? `${this.tableName}${DEFAULT_INDEX_NAME_SUFFIX}`;
    await this.engine.pool.query(
      `REINDEX INDEX "${this.schemaName}"."${name}";`,
    );
  }

  async dropVectorIndex(indexName?: string): Promise<void> {
    const name = indexName ?? `${this.tableName}${DEFAULT_INDEX_NAME_SUFFIX}`;
    await this.engine.pool.query(
      `DROP INDEX IF EXISTS "${this.schemaName}"."${name}";`,
    );
  }

  async isValidIndex(indexName?: string): Promise<boolean> {
    const name = indexName ?? `${this.tableName}${DEFAULT_INDEX_NAME_SUFFIX}`;
    const result = await this.engine.pool.query(
      "SELECT tablename, indexname FROM pg_indexes WHERE tablename = $1 AND schemaname = $2 AND indexname = $3;",
      [this.tableName, this.schemaName, name],
    );
    return result.rows.length === 1;
  }

  private async queryCollectionWithFilter(options: {
    limit?: number;
    offset?: number;
    filter?: Record<string, any>;
    columns: string[];
  }): Promise<Row[]> {
    const columnNames = options.columns.map((c) => `"${c}"`).join(", ");
    const params = new ParamBuilder();
    let whereFilters = "";
    if (options.filter) {
      const clause = createFilterClause(
        options.filter,
        this.filterContext(params),
      );
      if (clause) whereFilters = `WHERE ${clause}`;
    }
    const limitPlaceholder = params.add(options.limit ?? null);
    const offsetPlaceholder = params.add(options.offset ?? null);
    const query = `SELECT ${columnNames} FROM "${this.schemaName}"."${this.tableName}" ${whereFilters} LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder};`;
    const result = await this.engine.pool.query(query, params.values);
    return result.rows;
  }

  /** Retrieve documents using filters, similar to a Chroma-style `get()`. */
  async get(
    options: PGVectorStoreGetOptions = {},
  ): Promise<PGVectorStoreGetResult> {
    const filters: Record<string, any>[] = [];
    if (options.ids?.length)
      filters.push({ [this.idColumn]: { $in: options.ids } });
    if (options.where) filters.push(options.where);
    if (options.whereDocument)
      filters.push({ [this.contentColumn]: options.whereDocument });
    const finalFilter = filters.length ? { $and: filters } : undefined;

    const include = options.include ?? ["metadatas", "documents"];
    const fieldsMapping: Record<string, string[]> = {
      embeddings: [this.embeddingColumn],
      metadatas: this.metadataJsonColumn
        ? [...this.metadataColumns, this.metadataJsonColumn]
        : [...this.metadataColumns],
      documents: [this.contentColumn],
    };

    const includedFields = ["ids"];
    const columns = [this.idColumn];
    for (const [field, cols] of Object.entries(fieldsMapping)) {
      if (include.includes(field as "embeddings" | "metadatas" | "documents")) {
        includedFields.push(field);
        columns.push(...cols);
      }
    }

    const rows = await this.queryCollectionWithFilter({
      limit: options.limit,
      offset: options.offset,
      filter: finalFilter,
      columns,
    });

    const finalResults: Record<string, any[]> = Object.fromEntries(
      includedFields.map((f) => [f, []]),
    );
    for (const row of rows) {
      finalResults.ids.push(String(row[this.idColumn]));
      if (includedFields.includes("metadatas")) {
        const metadata = {
          ...((this.metadataJsonColumn
            ? row[this.metadataJsonColumn]
            : undefined) ?? {}),
        };
        for (const col of this.metadataColumns) metadata[col] = row[col];
        finalResults.metadatas.push(metadata);
      }
      if (includedFields.includes("documents")) {
        finalResults.documents.push(row[this.contentColumn]);
      }
      if (includedFields.includes("embeddings")) {
        finalResults.embeddings.push(JSON.parse(row[this.embeddingColumn]));
      }
    }
    return finalResults as unknown as PGVectorStoreGetResult;
  }

  async getByIds(ids: string[]): Promise<Document[]> {
    const columns = [
      ...this.metadataColumns,
      this.idColumn,
      this.contentColumn,
    ];
    if (this.metadataJsonColumn) columns.push(this.metadataJsonColumn);
    const columnNames = columns.map((c) => `"${c}"`).join(", ");

    const params = new ParamBuilder();
    const placeholders = ids.map((id) => params.add(id));
    const query = `SELECT ${columnNames} FROM "${this.schemaName}"."${this.tableName}" WHERE "${this.idColumn}" IN (${placeholders.join(", ")});`;
    const result = await this.engine.pool.query(query, params.values);
    return result.rows.map((row: Row) => this.rowToDocument(row));
  }
}
