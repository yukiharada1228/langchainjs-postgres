import { describe, expect, it } from "vitest";
import {
  DistanceStrategy,
  ExactNearestNeighbor,
  HNSWIndex,
  HNSWQueryOptions,
  IVFFlatIndex,
  IVFFlatQueryOptions,
  validateIdentifier,
} from "../src/indexes.js";

describe("indexes", () => {
  it("HNSWIndex defaults and index options string", () => {
    const index = new HNSWIndex();
    expect(index.m).toBe(16);
    expect(index.efConstruction).toBe(64);
    expect(index.indexOptions()).toBe("(m = 16, ef_construction = 64)");
    expect(index.getIndexFunction()).toBe(DistanceStrategy.COSINE_DISTANCE.indexFunction);
  });

  it("HNSWQueryOptions produces a SET LOCAL parameter", () => {
    const options = new HNSWQueryOptions({ efSearch: 100 });
    expect(options.toParameter()).toEqual(["hnsw.ef_search = 100"]);
  });

  it("IVFFlatIndex defaults and index options string", () => {
    const index = new IVFFlatIndex();
    expect(index.lists).toBe(100);
    expect(index.indexOptions()).toBe("(lists = 100)");
  });

  it("IVFFlatQueryOptions produces a SET LOCAL parameter", () => {
    const options = new IVFFlatQueryOptions({ probes: 5 });
    expect(options.toParameter()).toEqual(["ivfflat.probes = 5"]);
  });

  it("ExactNearestNeighbor has no index options", () => {
    const index = new ExactNearestNeighbor();
    expect(index.indexOptions()).toBe("");
  });

  it("uses the distance strategy's operator class for the index function", () => {
    const index = new HNSWIndex({ distanceStrategy: DistanceStrategy.EUCLIDEAN });
    expect(index.getIndexFunction()).toBe("vector_l2_ops");
  });

  it("validateIdentifier accepts safe identifiers", () => {
    expect(() => validateIdentifier("my_table_1")).not.toThrow();
  });

  it("validateIdentifier rejects unsafe identifiers", () => {
    expect(() => validateIdentifier("bad; drop table")).toThrow(/Invalid identifier/);
    expect(() => validateIdentifier("1leading")).toThrow(/Invalid identifier/);
  });
});
