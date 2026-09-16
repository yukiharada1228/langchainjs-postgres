export {
  Column,
  PGEngine,
  type ColumnDict,
  type ColumnLike,
} from "./engine.js";

export {
  PGVectorStore,
  type PGVectorStoreEmbeddings,
  type MMRByVectorOptions,
  type PGVectorStoreFromTextsOptions,
  type PGVectorStoreGetOptions,
  type PGVectorStoreGetResult,
  type PGVectorStoreInitializeOptions,
} from "./vectorstore.js";

export {
  BaseIndex,
  DEFAULT_DISTANCE_STRATEGY,
  DEFAULT_INDEX_NAME_SUFFIX,
  DistanceStrategy,
  ExactNearestNeighbor,
  HNSWIndex,
  HNSWQueryOptions,
  IVFFlatIndex,
  IVFFlatQueryOptions,
  QueryOptions,
  validateIdentifier,
  type BaseIndexArgs,
  type DistanceStrategyValue,
  type HNSWIndexArgs,
  type HNSWQueryOptionsArgs,
  type IVFFlatIndexArgs,
  type IVFFlatQueryOptionsArgs,
} from "./indexes.js";

export {
  HybridSearchConfig,
  reciprocalRankFusion,
  weightedSumRanking,
  type FusionFunction,
  type FusionFunctionParams,
  type HybridSearchConfigArgs,
  type Row,
} from "./hybrid_search.js";

export {
  createFilterClause,
  combineFilterClause,
  ParamBuilder,
  type FilterContext,
} from "./filter.js";

export { PGVectorTranslator } from "./translator.js";

export {
  PostgresChatMessageHistory,
  type PostgresChatMessageHistoryInput,
  type PostgresConnection,
} from "./chat_message_history.js";

export {
  LegacyDistanceStrategy,
  PGVector,
  type PGVectorFromTextsOptions,
  type PGVectorInitializeOptions,
} from "./legacy/vectorstore.js";
export { createLegacyFilterClause } from "./legacy/filter.js";

export {
  COLLECTIONS_TABLE,
  EMBEDDINGS_TABLE,
  extractPgvectorCollection,
  listPgvectorCollectionNames,
  migratePgvectorCollection,
  type MigratePgvectorCollectionOptions,
  type PgVectorRow,
} from "./pgvector_migrator.js";
