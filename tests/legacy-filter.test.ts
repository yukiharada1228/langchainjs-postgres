import { describe, expect, it } from "vitest";
import { ParamBuilder } from "../src/filter.js";
import { createLegacyFilterClause } from "../src/legacy/filter.js";

describe("createLegacyFilterClause", () => {
  it("compiles equality via jsonb_path_match", () => {
    const params = new ParamBuilder();
    const clause = createLegacyFilterClause({ category: "docs" }, params);
    expect(clause).toBe(
      "jsonb_path_match(cmetadata, ($1)::jsonpath, ($2)::jsonb)",
    );
    expect(params.values).toEqual(["$.category == $value", JSON.stringify({ value: "docs" })]);
  });

  it("compiles $between into two ANDed jsonb_path_match calls", () => {
    const params = new ParamBuilder();
    const clause = createLegacyFilterClause({ year: { $between: [2000, 2020] } }, params);
    expect(clause).toContain("AND");
    expect(params.values).toEqual([
      "$.year >= $value",
      JSON.stringify({ value: 2000 }),
      "$.year <= $value",
      JSON.stringify({ value: 2020 }),
    ]);
  });

  it("compiles $in against the extracted text value", () => {
    const params = new ParamBuilder();
    const clause = createLegacyFilterClause({ category: { $in: ["docs", "faq"] } }, params);
    expect(clause).toBe("(cmetadata->>'category') = ANY($1)");
    expect(params.values).toEqual([["docs", "faq"]]);
  });

  it("compiles $exists via jsonb_exists", () => {
    const params = new ParamBuilder();
    const clause = createLegacyFilterClause({ category: { $exists: true } }, params);
    expect(clause).toBe("jsonb_exists(cmetadata, 'category')");
  });

  it("supports $and combinators", () => {
    const params = new ParamBuilder();
    const clause = createLegacyFilterClause(
      { $and: [{ category: "docs" }, { category: { $ne: "faq" } }] },
      params,
    );
    expect(clause.startsWith("(jsonb_path_match")).toBe(true);
    expect(clause).toContain(" AND ");
  });
});
