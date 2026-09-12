import { describe, expect, it } from "vitest";
import { createFilterClause, ParamBuilder, type FilterContext } from "../src/filter.js";

function context(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    metadataJsonColumn: "langchain_metadata",
    metadataColumns: ["category"],
    idColumn: "langchain_id",
    contentColumn: "content",
    embeddingColumn: "embedding",
    params: new ParamBuilder(),
    ...overrides,
  };
}

describe("createFilterClause", () => {
  it("compiles a simple equality filter on a typed metadata column", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ category: "docs" }, context({ params }));
    expect(clause).toBe("category = $1");
    expect(params.values).toEqual(["docs"]);
  });

  it("routes unknown fields through the metadata JSON column as ->> text", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ author: "ada" }, context({ params }));
    expect(clause).toBe("langchain_metadata->>'author' = $1");
    expect(params.values).toEqual(["ada"]);
  });

  it("builds a nested JSON path with a numeric cast for the last segment", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ "author.age": { $gt: 30 } }, context({ params }));
    expect(clause).toBe("(langchain_metadata->'author'->>'age')::INTEGER > $1");
    expect(params.values).toEqual([30]);
  });

  it("combines multiple top-level fields with AND", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause(
      { category: "docs", author: "ada" },
      context({ params }),
    );
    expect(clause).toBe("(category = $1 AND langchain_metadata->>'author' = $2)");
    expect(params.values).toEqual(["docs", "ada"]);
  });

  it("supports $and / $or / $not combinators", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause(
      {
        $and: [{ category: "docs" }, { $or: [{ author: "ada" }, { author: "grace" }] }],
      },
      context({ params }),
    );
    expect(clause).toBe(
      "(category = $1 AND (langchain_metadata->>'author' = $2 OR langchain_metadata->>'author' = $3))",
    );
    expect(params.values).toEqual(["docs", "ada", "grace"]);
  });

  it("supports $not with a single condition", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ $not: { category: "docs" } }, context({ params }));
    expect(clause).toBe("(NOT category = $1)");
    expect(params.values).toEqual(["docs"]);
  });

  it("supports $in / $nin using ANY / ALL", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause(
      { category: { $in: ["docs", "faq"] } },
      context({ params }),
    );
    expect(clause).toBe("category = ANY($1)");
    expect(params.values).toEqual([["docs", "faq"]]);
  });

  it("supports $between", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause(
      { "meta.year": { $between: [2000, 2020] } },
      context({ params }),
    );
    expect(clause).toBe(
      "((langchain_metadata->'meta'->>'year')::INTEGER BETWEEN $1 AND $2)",
    );
    expect(params.values).toEqual([2000, 2020]);
  });

  it("supports $exists", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ author: { $exists: false } }, context({ params }));
    expect(clause).toBe("(langchain_metadata->>'author' IS NULL)");
    expect(params.values).toEqual([]);
  });

  it("supports $like / $ilike", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ author: { $ilike: "%ada%" } }, context({ params }));
    expect(clause).toBe("(langchain_metadata->>'author' ILIKE $1)");
    expect(params.values).toEqual(["%ada%"]);
  });

  it("rejects an operator used as a top-level field name", () => {
    expect(() => createFilterClause({ $bogus: "x" }, context())).toThrow(
      /Expected \$and, \$or or \$not/,
    );
  });

  it("rejects an unsupported operator", () => {
    expect(() => createFilterClause({ category: { $regex: "x" } }, context())).toThrow(
      /Invalid operator/,
    );
  });

  it("rejects an unknown top-level $ operator", () => {
    expect(() => createFilterClause({ $invalid: "x" }, context())).toThrow(
      /Expected \$and, \$or or \$not/,
    );
  });

  it("does not route id/content/embedding columns through the JSON column", () => {
    const params = new ParamBuilder();
    const clause = createFilterClause({ langchain_id: "abc" }, context({ params }));
    expect(clause).toBe("langchain_id = $1");
  });
});
