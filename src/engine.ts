/**
 * Connection pool manager for Postgres.
 *
 * Ported from `langchain_postgres.v2.engine` (Python). The Python
 * implementation juggles a background event loop so that async SQLAlchemy
 * calls can be exposed synchronously; that machinery is unnecessary in
 * JavaScript since everything here is already Promise-based.
 */
import { Pool, type PoolConfig } from "pg";
import { HybridSearchConfig } from "./hybrid_search.js";

export interface ColumnDict {
  name: string;
  dataType: string;
  nullable?: boolean;
}

/** Describes a metadata column on a vectorstore table. */
export class Column {
  name: string;
  dataType: string;
  nullable: boolean;

  constructor(name: string, dataType: string, nullable = true) {
    if (typeof name !== "string") {
      throw new TypeError("Column name must be type string");
    }
    if (typeof dataType !== "string") {
      throw new TypeError("Column data_type must be type string");
    }
    this.name = name;
    this.dataType = dataType;
    this.nullable = nullable;
  }
}

export type ColumnLike = Column | ColumnDict;

function escapePostgresIdentifier(name: string): string {
  return name.replace(/"/g, '""');
}

function normalizeColumn(col: ColumnLike): {
  name: string;
  dataType: string;
  nullable: boolean;
} {
  if (col instanceof Column) {
    return { name: col.name, dataType: col.dataType, nullable: col.nullable };
  }
  return {
    name: col.name,
    dataType: col.dataType,
    nullable: col.nullable ?? true,
  };
}

export interface InitVectorstoreTableOptions {
  schemaName?: string;
  contentColumn?: string;
  embeddingColumn?: string;
  metadataColumns?: ColumnLike[];
  metadataJsonColumn?: string;
  idColumn?: string | ColumnLike;
  overwriteExisting?: boolean;
  storeMetadata?: boolean;
  hybridSearchConfig?: HybridSearchConfig;
}

/** A class for managing connections to a Postgres database. */
export class PGEngine {
  /** The underlying `pg` connection pool. Exposed for advanced use cases. */
  readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Create a PGEngine instance from an existing `pg.Pool`. */
  static fromPool(pool: Pool): PGEngine {
    return new PGEngine(pool);
  }

  /** Create a PGEngine instance from a Postgres connection string. */
  static fromConnectionString(
    url: string,
    poolConfig: Omit<PoolConfig, "connectionString"> = {},
  ): PGEngine {
    const pool = new Pool({ ...poolConfig, connectionString: url });
    return new PGEngine(pool);
  }

  /** Dispose of the connection pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Create a table for saving vectors to be used with {@link PGVectorStore}.
   *
   * @throws if the table already exists, or if the data type of the id
   *   column is not a valid PostgreSQL data type.
   */
  async initVectorstoreTable(
    tableName: string,
    vectorSize: number,
    options: InitVectorstoreTableOptions = {},
  ): Promise<void> {
    const schemaName = escapePostgresIdentifier(options.schemaName ?? "public");
    const escapedTableName = escapePostgresIdentifier(tableName);
    const hybridSearchDefaultColumnName = `${options.contentColumn ?? "content"}_tsv`;
    const contentColumn = escapePostgresIdentifier(
      options.contentColumn ?? "content",
    );
    const embeddingColumn = escapePostgresIdentifier(
      options.embeddingColumn ?? "embedding",
    );
    const metadataColumns = (options.metadataColumns ?? []).map(
      normalizeColumn,
    );
    for (const col of metadataColumns)
      col.name = escapePostgresIdentifier(col.name);

    const idColumnInput = options.idColumn ?? "langchain_id";
    let idColumnName: string;
    let idDataType: string;
    if (typeof idColumnInput === "string") {
      idColumnName = escapePostgresIdentifier(idColumnInput);
      idDataType = "UUID";
    } else {
      const normalized = normalizeColumn(idColumnInput);
      idColumnName = escapePostgresIdentifier(normalized.name);
      idDataType = normalized.dataType;
    }

    const metadataJsonColumn =
      options.metadataJsonColumn ?? "langchain_metadata";
    const storeMetadata = options.storeMetadata ?? true;

    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    if (options.overwriteExisting) {
      await this.pool.query(
        `DROP TABLE IF EXISTS "${schemaName}"."${escapedTableName}"`,
      );
    }

    let hybridSearchColumn = "";
    const hybridSearchConfig = options.hybridSearchConfig;
    if (hybridSearchConfig) {
      const hybridSearchColumnName = escapePostgresIdentifier(
        hybridSearchConfig.tsvColumn || hybridSearchDefaultColumnName,
      );
      hybridSearchConfig.tsvColumn = hybridSearchColumnName;
      hybridSearchColumn = `,"${hybridSearchColumnName}" TSVECTOR NOT NULL`;
    }

    let query = `CREATE TABLE "${schemaName}"."${escapedTableName}"(
      "${idColumnName}" ${idDataType} PRIMARY KEY,
      "${contentColumn}" TEXT NOT NULL,
      "${embeddingColumn}" vector(${vectorSize}) NOT NULL
      ${hybridSearchColumn}`;
    for (const column of metadataColumns) {
      const nullable = column.nullable ? "" : "NOT NULL";
      query += `,\n"${column.name}" ${column.dataType} ${nullable}`;
    }
    if (storeMetadata) {
      query += `,\n"${metadataJsonColumn}" JSON`;
    }
    query += "\n);";

    await this.pool.query(query);
  }

  /** Drop the vector store table. */
  async dropTable(
    tableName: string,
    options: { schemaName?: string } = {},
  ): Promise<void> {
    const schemaName = options.schemaName ?? "public";
    await this.pool.query(
      `DROP TABLE IF EXISTS "${schemaName}"."${tableName}";`,
    );
  }
}
