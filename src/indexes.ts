/**
 * Vector index definitions for {@link PGVectorStore}.
 *
 * Ported from `langchain_postgres.v2.indexes` (Python).
 * Learn more about pgvector indexes at https://github.com/pgvector/pgvector#indexing
 */

export interface DistanceStrategyValue {
  /** Operator used in `ORDER BY` clauses, e.g. `<=>`. */
  operator: string;
  /** SQL function name used to compute distance/similarity, e.g. `cosine_distance`. */
  searchFunction: string;
  /** pgvector index operator class, e.g. `vector_cosine_ops`. */
  indexFunction: string;
}

/** Enumerator of the supported pgvector distance strategies. */
export const DistanceStrategy = {
  EUCLIDEAN: {
    operator: "<->",
    searchFunction: "l2_distance",
    indexFunction: "vector_l2_ops",
  },
  COSINE_DISTANCE: {
    operator: "<=>",
    searchFunction: "cosine_distance",
    indexFunction: "vector_cosine_ops",
  },
  INNER_PRODUCT: {
    operator: "<#>",
    searchFunction: "inner_product",
    indexFunction: "vector_ip_ops",
  },
} as const satisfies Record<string, DistanceStrategyValue>;

export type DistanceStrategy =
  (typeof DistanceStrategy)[keyof typeof DistanceStrategy];

export const DEFAULT_DISTANCE_STRATEGY: DistanceStrategy =
  DistanceStrategy.COSINE_DISTANCE;
export const DEFAULT_INDEX_NAME_SUFFIX = "langchainvectorindex";

export function validateIdentifier(identifier: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(
      `Invalid identifier: ${identifier}. Identifiers must start with a letter or underscore, and subsequent characters can be letters, digits, or underscores.`,
    );
  }
}

export interface BaseIndexArgs {
  name?: string;
  distanceStrategy?: DistanceStrategy;
  partialIndexes?: string[];
  extensionName?: string;
}

/** Abstract base class for defining vector indexes. */
export abstract class BaseIndex {
  name?: string;
  indexType = "base";
  distanceStrategy: DistanceStrategy;
  partialIndexes?: string[];
  extensionName?: string;

  constructor(args: BaseIndexArgs = {}) {
    this.name = args.name;
    this.distanceStrategy = args.distanceStrategy ?? DEFAULT_DISTANCE_STRATEGY;
    this.partialIndexes = args.partialIndexes;
    this.extensionName = args.extensionName;
    if (this.extensionName) validateIdentifier(this.extensionName);
    if (this.indexType) validateIdentifier(this.indexType);
  }

  /** Set index query options for vector store initialization. */
  abstract indexOptions(): string;

  getIndexFunction(): string {
    return this.distanceStrategy.indexFunction;
  }
}

/** Sentinel index used to request removal of a vector index. */
export class ExactNearestNeighbor extends BaseIndex {
  override indexType = "exactnearestneighbor";

  indexOptions(): string {
    return "";
  }
}

export abstract class QueryOptions {
  /** Convert index attributes to a list of `SET LOCAL` configurations. */
  abstract toParameter(): string[];
}

export interface HNSWIndexArgs extends BaseIndexArgs {
  m?: number;
  efConstruction?: number;
}

export class HNSWIndex extends BaseIndex {
  override indexType = "hnsw";
  m: number;
  efConstruction: number;

  constructor(args: HNSWIndexArgs = {}) {
    super(args);
    this.m = args.m ?? 16;
    this.efConstruction = args.efConstruction ?? 64;
  }

  indexOptions(): string {
    return `(m = ${this.m}, ef_construction = ${this.efConstruction})`;
  }
}

export interface HNSWQueryOptionsArgs {
  efSearch?: number;
}

export class HNSWQueryOptions extends QueryOptions {
  efSearch: number;

  constructor(args: HNSWQueryOptionsArgs = {}) {
    super();
    this.efSearch = args.efSearch ?? 40;
  }

  toParameter(): string[] {
    return [`hnsw.ef_search = ${this.efSearch}`];
  }
}

export interface IVFFlatIndexArgs extends BaseIndexArgs {
  lists?: number;
}

export class IVFFlatIndex extends BaseIndex {
  override indexType = "ivfflat";
  lists: number;

  constructor(args: IVFFlatIndexArgs = {}) {
    super(args);
    this.lists = args.lists ?? 100;
  }

  indexOptions(): string {
    return `(lists = ${this.lists})`;
  }
}

export interface IVFFlatQueryOptionsArgs {
  probes?: number;
}

export class IVFFlatQueryOptions extends QueryOptions {
  probes: number;

  constructor(args: IVFFlatQueryOptionsArgs = {}) {
    super();
    this.probes = args.probes ?? 1;
  }

  toParameter(): string[] {
    return [`ivfflat.probes = ${this.probes}`];
  }
}
