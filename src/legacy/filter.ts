/**
 * Metadata filter compiler for the legacy {@link PGVector} store.
 *
 * Ported from `PGVector._handle_field_filter` (Python, `vectorstores.py`).
 * Unlike the v2 store, legacy metadata always lives in a single `cmetadata`
 * JSONB column, so equality-style comparators use Postgres's `jsonb_path_match`
 * (mirroring the SQLAlchemy `func.jsonb_path_match(...)` calls upstream) while
 * `$in`/`$nin`/`$like`/`$ilike` operate on the extracted text value.
 */
import { combineFilterClause, ParamBuilder } from "../filter.js";

const COMPARISONS_TO_JSONPATH: Record<string, string> = {
  $eq: "==",
  $ne: "!=",
  $lt: "<",
  $lte: "<=",
  $gt: ">",
  $gte: ">=",
};

const SUPPORTED_OPERATORS = new Set([
  ...Object.keys(COMPARISONS_TO_JSONPATH),
  "$in",
  "$nin",
  "$between",
  "$exists",
  "$like",
  "$ilike",
  "$and",
  "$or",
  "$not",
]);

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function handleFieldFilter(
  field: string,
  value: unknown,
  params: ParamBuilder,
): string {
  if (typeof field !== "string") {
    throw new Error(`field should be a string but got: ${typeof field}`);
  }
  if (field.startsWith("$")) {
    throw new Error(
      `Invalid filter condition. Expected a field but got an operator: ${field}`,
    );
  }
  if (!isIdentifier(field)) {
    throw new Error(
      `Invalid field name: ${field}. Expected a valid identifier.`,
    );
  }

  let operator: string;
  let filterValue: unknown;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new Error(
        "Invalid filter condition. Expected a value which is a dictionary with " +
          `a single key that corresponds to an operator but got a dictionary with ${entries.length} keys.`,
      );
    }
    [operator, filterValue] = entries[0];
    if (!SUPPORTED_OPERATORS.has(operator)) {
      throw new Error(`Invalid operator: ${operator}`);
    }
  } else {
    operator = "$eq";
    filterValue = value;
  }

  if (operator in COMPARISONS_TO_JSONPATH) {
    const native = COMPARISONS_TO_JSONPATH[operator];
    const pathPlaceholder = params.add(`$.${field} ${native} $value`);
    const valuePlaceholder = params.add(JSON.stringify({ value: filterValue }));
    return `jsonb_path_match(cmetadata, (${pathPlaceholder})::jsonpath, (${valuePlaceholder})::jsonb)`;
  }

  if (operator === "$between") {
    const [low, high] = filterValue as [unknown, unknown];
    const lowPath = params.add(`$.${field} >= $value`);
    const lowVal = params.add(JSON.stringify({ value: low }));
    const highPath = params.add(`$.${field} <= $value`);
    const highVal = params.add(JSON.stringify({ value: high }));
    return (
      `(jsonb_path_match(cmetadata, (${lowPath})::jsonpath, (${lowVal})::jsonb) AND ` +
      `jsonb_path_match(cmetadata, (${highPath})::jsonpath, (${highVal})::jsonb))`
    );
  }

  const fieldExpr = `(cmetadata->>'${field}')`;

  if (operator === "$in" || operator === "$nin") {
    const values = (filterValue as unknown[]).map((v) => {
      if (typeof v === "boolean" || !["string", "number"].includes(typeof v)) {
        throw new Error(`Unsupported type for value: ${JSON.stringify(v)}`);
      }
      return String(v);
    });
    const placeholder = params.add(values);
    return operator === "$in"
      ? `${fieldExpr} = ANY(${placeholder})`
      : `${fieldExpr} <> ALL(${placeholder})`;
  }

  if (operator === "$like" || operator === "$ilike") {
    const placeholder = params.add(filterValue);
    return operator === "$like"
      ? `(${fieldExpr} LIKE ${placeholder})`
      : `(${fieldExpr} ILIKE ${placeholder})`;
  }

  if (operator === "$exists") {
    if (typeof filterValue !== "boolean") {
      throw new Error("Expected a boolean value for $exists operator");
    }
    const condition = `jsonb_exists(cmetadata, '${field}')`;
    return filterValue ? condition : `(NOT ${condition})`;
  }

  throw new Error(`Unsupported operator: ${operator}`);
}

/** Compile a LangChain metadata filter dictionary against the legacy `cmetadata` column. */
export function createLegacyFilterClause(
  filters: unknown,
  params: ParamBuilder,
): string {
  return combineFilterClause(filters, (field, value) =>
    handleFieldFilter(field, value, params),
  );
}
