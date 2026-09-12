import { Comparison, Operation, StructuredQuery } from "@langchain/core/structured_query";
import { describe, expect, it } from "vitest";
import { PGVectorTranslator } from "../src/translator.js";

describe("PGVectorTranslator", () => {
  it("translates a single comparison", () => {
    const translator = new PGVectorTranslator();
    const query = new StructuredQuery(
      "cats",
      new Comparison("eq", "category", "docs"),
    );
    const result = translator.visitStructuredQuery(query);
    expect(result).toEqual({ filter: { category: { $eq: "docs" } } });
  });

  it("translates an AND operation of two comparisons", () => {
    const translator = new PGVectorTranslator();
    const query = new StructuredQuery(
      "cats",
      new Operation("and", [
        new Comparison("gt", "year", 2000),
        new Comparison("eq", "category", "docs"),
      ]),
    );
    const result = translator.visitStructuredQuery(query);
    expect(result).toEqual({
      filter: {
        $and: [{ year: { $gt: 2000 } }, { category: { $eq: "docs" } }],
      },
    });
  });

  it("returns an empty object when there is no filter", () => {
    const translator = new PGVectorTranslator();
    const query = new StructuredQuery("cats");
    expect(translator.visitStructuredQuery(query)).toEqual({});
  });

  it("rejects the NOT operator (not in the allowed operator list)", () => {
    const translator = new PGVectorTranslator();
    expect(() =>
      translator.visitOperation(new Operation("not", [new Comparison("eq", "category", "docs")])),
    ).toThrow(/disallowed function/);
  });
});
