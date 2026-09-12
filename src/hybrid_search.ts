/**
 * Hybrid (dense + sparse) search configuration and fusion functions.
 *
 * Ported from `langchain_postgres.v2.hybrid_search_config` (Python).
 *
 * Queries might be slow if the hybrid search column does not exist. For best
 * hybrid search performance, consider creating a TSV column and adding a GIN
 * index via {@link PGVectorStore.applyHybridSearchIndex}.
 */
import { DistanceStrategy } from "./indexes.js";

/** A single row returned from a SQL query, keyed by column name. */
export type Row = Record<string, any>;

function normalizeScores(results: Row[], isDistanceMetric: boolean): Row[] {
  if (results.length === 0) return [];

  const lastValue = (row: Row): number => {
    const values = Object.values(row);
    return Number(values[values.length - 1]);
  };

  const scores = results.map(lastValue);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const scoreRange = maxScore - minScore;

  if (scoreRange === 0) {
    return results.map((item) => ({ ...item, normalized_score: 1.0 }));
  }

  return results.map((item) => {
    const score = lastValue(item);
    const normalized = (score - minScore) / scoreRange;
    const normalizedScore = isDistanceMetric ? 1.0 - normalized : normalized;
    return { ...item, normalized_score: normalizedScore };
  });
}

export interface FusionFunctionParams {
  fetchTopK?: number;
  distanceStrategy?: DistanceStrategy;
  [key: string]: unknown;
}

export type FusionFunction = (
  primarySearchResults: Row[],
  secondarySearchResults: Row[],
  params?: FusionFunctionParams,
) => Row[];

/** Ranks documents using a weighted sum of scores from two sources. */
export const weightedSumRanking: FusionFunction = (
  primarySearchResults,
  secondarySearchResults,
  params = {},
) => {
  const primaryResultsWeight = (params.primaryResultsWeight as number) ?? 0.5;
  const secondaryResultsWeight =
    (params.secondaryResultsWeight as number) ?? 0.5;
  const fetchTopK = params.fetchTopK ?? 4;
  const distanceStrategy =
    params.distanceStrategy ?? DistanceStrategy.COSINE_DISTANCE;
  const isPrimaryDistance = distanceStrategy !== DistanceStrategy.INNER_PRODUCT;

  const normalizedPrimary = normalizeScores(
    primarySearchResults,
    isPrimaryDistance,
  );
  const normalizedSecondary = normalizeScores(secondarySearchResults, false);

  const weightedScores = new Map<string, Row>();

  for (const item of normalizedPrimary) {
    const docId = String(Object.values(item)[0]);
    const row = {
      ...item,
      distance: item.normalized_score * primaryResultsWeight,
    };
    weightedScores.set(docId, row);
  }

  for (const item of normalizedSecondary) {
    const docId = String(Object.values(item)[0]);
    const secondaryWeightedScore =
      item.normalized_score * secondaryResultsWeight;
    const existing = weightedScores.get(docId);
    if (existing) {
      existing.distance += secondaryWeightedScore;
    } else {
      weightedScores.set(docId, {
        ...item,
        distance: secondaryWeightedScore,
      });
    }
  }

  const ranked = [...weightedScores.values()].sort(
    (a, b) => b.distance - a.distance,
  );
  for (const row of ranked) delete row.normalized_score;
  return ranked.slice(0, fetchTopK);
};

/** Ranks documents using Reciprocal Rank Fusion (RRF) of scores from two sources. */
export const reciprocalRankFusion: FusionFunction = (
  primarySearchResults,
  secondarySearchResults,
  params = {},
) => {
  const rrfK = (params.rrfK as number) ?? 60;
  const fetchTopK = params.fetchTopK ?? 4;
  const distanceStrategy =
    params.distanceStrategy ?? DistanceStrategy.COSINE_DISTANCE;
  const isSimilarityMetric =
    distanceStrategy === DistanceStrategy.INNER_PRODUCT;

  const rrfScores = new Map<string, Row>();

  const sortedPrimary = [...primarySearchResults].sort((a, b) =>
    isSimilarityMetric ? b.distance - a.distance : a.distance - b.distance,
  );
  sortedPrimary.forEach((row, rank) => {
    const docId = String(Object.values(row)[0]);
    if (!rrfScores.has(docId)) {
      rrfScores.set(docId, { ...row, distance: 0.0 });
    }
    rrfScores.get(docId)!.distance += 1.0 / (rank + rrfK);
  });

  const sortedSecondary = [...secondarySearchResults].sort(
    (a, b) => b.distance - a.distance,
  );
  sortedSecondary.forEach((row, rank) => {
    const docId = String(Object.values(row)[0]);
    if (!rrfScores.has(docId)) {
      rrfScores.set(docId, { ...row, distance: 0.0 });
    }
    rrfScores.get(docId)!.distance += 1.0 / (rank + rrfK);
  });

  const ranked = [...rrfScores.values()].sort(
    (a, b) => b.distance - a.distance,
  );
  return ranked.slice(0, fetchTopK);
};

export interface HybridSearchConfigArgs {
  tsvColumn?: string;
  tsvLang?: string;
  ftsQuery?: string;
  fusionFunction?: FusionFunction;
  fusionFunctionParameters?: FusionFunctionParams;
  primaryTopK?: number;
  secondaryTopK?: number;
  indexName?: string;
  indexType?: string;
}

/** Hybrid search configuration for {@link PGVectorStore}. */
export class HybridSearchConfig {
  tsvColumn?: string;
  tsvLang?: string;
  ftsQuery?: string;
  fusionFunction: FusionFunction;
  fusionFunctionParameters: FusionFunctionParams;
  primaryTopK: number;
  secondaryTopK: number;
  indexName: string;
  indexType: string;

  constructor(args: HybridSearchConfigArgs = {}) {
    this.tsvColumn = args.tsvColumn ?? "";
    this.tsvLang = args.tsvLang ?? "pg_catalog.english";
    this.ftsQuery = args.ftsQuery ?? "";
    this.fusionFunction = args.fusionFunction ?? weightedSumRanking;
    this.fusionFunctionParameters = args.fusionFunctionParameters ?? {};
    this.primaryTopK = args.primaryTopK ?? 4;
    this.secondaryTopK = args.secondaryTopK ?? 4;
    this.indexName = args.indexName ?? "langchain_tsv_index";
    this.indexType = args.indexType ?? "GIN";
  }
}
