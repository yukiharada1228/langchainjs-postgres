/**
 * Self-query retriever translator for {@link PGVectorStore}.
 *
 * Ported from `langchain_postgres.translator.PGVectorTranslator` (Python).
 * Translates the LangChain self-query IR into the Mongo-style filter
 * dictionaries understood by {@link createFilterClause} in `filter.ts`.
 *
 * Note: `@langchain/core`'s structured-query IR only defines the
 * `eq/ne/lt/gt/lte/gte` comparators (the Python IR additionally has
 * `in/nin/contain/like`), so this translator's allowed comparator list is
 * necessarily a subset of the Python original.
 */
import {
  Comparators,
  Operators,
  Visitor,
  type Comparator,
  type Comparison,
  type Operation,
  type Operator,
  type StructuredQuery,
  type VisitorComparisonResult,
  type VisitorOperationResult,
  type VisitorStructuredQueryResult,
} from "@langchain/core/structured_query";

import type { PGVectorStore } from "./vectorstore.js";

/** Translate LangChain self-query filters into `PGVectorStore` filter dictionaries. */
export class PGVectorTranslator extends Visitor<PGVectorStore> {
  declare VisitOperationOutput: VisitorOperationResult;

  declare VisitComparisonOutput: VisitorComparisonResult;

  declare VisitStructuredQueryOutput: VisitorStructuredQueryResult;

  allowedOperators: Operator[] = [Operators.and, Operators.or];

  allowedComparators: Comparator[] = [
    Comparators.eq,
    Comparators.ne,
    Comparators.gt,
    Comparators.lt,
    Comparators.gte,
    Comparators.lte,
  ];

  private validateFunction(func: Operator | Comparator): void {
    if (
      !this.allowedOperators.includes(func as Operator) &&
      !this.allowedComparators.includes(func as Comparator)
    ) {
      throw new Error(`Received disallowed function ${func}`);
    }
  }

  private formatFunction(func: Operator | Comparator): string {
    this.validateFunction(func);
    return `$${func}`;
  }

  visitOperation(operation: Operation): VisitorOperationResult {
    const args = (operation.args?.map((arg) => arg.accept(this)) ?? []) as (
      VisitorOperationResult | VisitorComparisonResult
    )[];
    return { [this.formatFunction(operation.operator)]: args };
  }

  visitComparison(comparison: Comparison): VisitorComparisonResult {
    return {
      [comparison.attribute]: {
        [this.formatFunction(comparison.comparator)]: comparison.value,
      },
    };
  }

  visitStructuredQuery(
    structuredQuery: StructuredQuery,
  ): VisitorStructuredQueryResult {
    if (!structuredQuery.filter) return {};
    return {
      filter: structuredQuery.filter.accept(this) as Record<string, any>,
    };
  }
}
