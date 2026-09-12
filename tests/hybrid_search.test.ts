import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, weightedSumRanking } from "../src/hybrid_search.js";

describe("weightedSumRanking", () => {
  it("normalizes and combines dense + sparse scores", () => {
    const primary = [
      { id: "a", distance: 0.1 },
      { id: "b", distance: 0.5 },
    ];
    const secondary = [
      { id: "a", distance: 2.0 },
      { id: "c", distance: 1.0 },
    ];

    const ranked = weightedSumRanking(primary, secondary, { fetchTopK: 10 });

    expect(ranked.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0].distance).toBeCloseTo(1.0);
    expect(ranked[1].distance).toBeCloseTo(0);
    expect(ranked[2].distance).toBeCloseTo(0);
  });

  it("respects fetchTopK", () => {
    const primary = [
      { id: "a", distance: 0.1 },
      { id: "b", distance: 0.2 },
      { id: "c", distance: 0.3 },
    ];
    const ranked = weightedSumRanking(primary, [], { fetchTopK: 2 });
    expect(ranked).toHaveLength(2);
  });

  it("returns a full-score row when every row ties", () => {
    const primary = [
      { id: "a", distance: 0.4 },
      { id: "b", distance: 0.4 },
    ];
    const ranked = weightedSumRanking(primary, []);
    expect(ranked.every((r) => r.distance === 0.5)).toBe(true);
  });
});

describe("reciprocalRankFusion", () => {
  it("combines rank-based scores from both sources", () => {
    const primary = [
      { id: "a", distance: 0.1 },
      { id: "b", distance: 0.5 },
    ];
    const secondary = [
      { id: "a", distance: 2.0 },
      { id: "c", distance: 1.0 },
    ];

    const ranked = reciprocalRankFusion(primary, secondary, { fetchTopK: 10 });

    expect(ranked.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0].distance).toBeCloseTo(1 / 60 + 1 / 60);
    expect(ranked[1].distance).toBeCloseTo(1 / 61);
    expect(ranked[2].distance).toBeCloseTo(1 / 61);
  });
});
