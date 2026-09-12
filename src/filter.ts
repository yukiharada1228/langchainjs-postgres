/**
 * Metadata filter compiler shared by {@link PGVectorStore}.
 *
 * Ported from `AsyncPGVectorStore._create_filter_clause` /
 * `_handle_field_filter` (Python). Builds parameterized SQL `WHERE` clause
 * fragments from LangChain's Mongo-style filter dictionaries.
 */

/** Accumulates query parameters and hands out `$n` positional placeholders. */
export class ParamBuilder {
  values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface FilterContext {
  metadataJsonColumn?: string;
  metadataColumns: string[];
  idColumn: string;
  contentColumn: string;
  embeddingColumn: string;
  params: ParamBuilder;
}

const COMPARISONS_TO_NATIVE: Record<string, string> = {
  $eq: "=",
  $ne: "!=",
  $lt: "<",
  $lte: "<=",
  $gt: ">",
  $gte: ">=",
};

const SPECIAL_CASED_OPERATORS = new Set(["$in", "$nin", "$between", "$exists"]);
const TEXT_OPERATORS = new Set(["$like", "$ilike"]);
const LOGICAL_OPERATORS = new Set(["$and", "$or", "$not"]);

const SUPPORTED_OPERATORS = new Set([
  ...Object.keys(COMPARISONS_TO_NATIVE),
  ...TEXT_OPERATORS,
  ...LOGICAL_OPERATORS,
  ...SPECIAL_CASED_OPERATORS,
]);

type PostgresScalarType =
  "INTEGER" | "FLOAT" | "TEXT" | "BOOLEAN" | "DATE" | "TIMESTAMP" | "TIME";

function inferPostgresType(value: unknown): PostgresScalarType | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) ? "INTEGER" : "FLOAT";
  }
  if (typeof value === "string") return "TEXT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (value instanceof Date) return "TIMESTAMP";
  return undefined;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function buildFieldSelector(
  field: string,
  ctx: FilterContext,
): { selector: string; hasJsonPath: boolean } {
  let fieldSelector = field;
  const fieldColumn = field.split(".")[0];

  if (
    ctx.metadataJsonColumn &&
    !ctx.metadataColumns.includes(fieldColumn) &&
    ![ctx.idColumn, ctx.contentColumn, ctx.embeddingColumn].includes(
      fieldColumn,
    )
  ) {
    fieldSelector = `${ctx.metadataJsonColumn}.${fieldSelector}`;
  }

  const hasJsonPath = fieldSelector.includes(".");
  if (hasJsonPath) {
    const parts = fieldSelector.split(".");
    fieldSelector = parts
      .map((part, ind) =>
        ind === 0 ? part : `${ind === parts.length - 1 ? ">" : ""}'${part}'`,
      )
      .join("->");
  }

  return { selector: fieldSelector, hasJsonPath };
}

function handleFieldFilter(
  field: string,
  value: unknown,
  ctx: FilterContext,
): string {
  if (typeof field !== "string") {
    throw new Error(`field should be a string but got: ${typeof field}`);
  }
  if (field.startsWith("$")) {
    throw new Error(
      `Invalid filter condition. Expected a field but got an operator: ${field}`,
    );
  }
  if (!(isIdentifier(field) || field.split(".").every(isIdentifier))) {
    throw new Error(
      `Invalid field name: ${field}. Expected a valid identifier.`,
    );
  }

  let operator: string;
  let filterValue: unknown;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new Error(
        "Invalid filter condition. Expected a value which is a dictionary with " +
          `a single key that corresponds to an operator but got a dictionary with ${entries.length} keys.`,
      );
    }
    [operator, filterValue] = entries[0];
    if (!SUPPORTED_OPERATORS.has(operator)) {
      throw new Error(
        `Invalid operator: ${operator}. Expected one of ${[...SUPPORTED_OPERATORS].join(", ")}`,
      );
    }
  } else {
    operator = "$eq";
    filterValue = value;
  }

  const { selector, hasJsonPath } = buildFieldSelector(field, ctx);
  let fieldSelector = selector;

  if (hasJsonPath) {
    const sample = Array.isArray(filterValue) ? filterValue[0] : filterValue;
    const postgresType = inferPostgresType(sample);
    if (!postgresType) {
      throw new Error(`Unsupported type for value: ${JSON.stringify(sample)}`);
    }
    if (postgresType !== "TEXT" && operator !== "$exists") {
      fieldSelector = `(${fieldSelector})::${postgresType}`;
    }
  }

  if (operator in COMPARISONS_TO_NATIVE) {
    const native = COMPARISONS_TO_NATIVE[operator];
    const placeholder = ctx.params.add(filterValue);
    return `${fieldSelector} ${native} ${placeholder}`;
  }

  if (operator === "$between") {
    const [low, high] = filterValue as [unknown, unknown];
    const lowPlaceholder = ctx.params.add(low);
    const highPlaceholder = ctx.params.add(high);
    return `(${fieldSelector} BETWEEN ${lowPlaceholder} AND ${highPlaceholder})`;
  }

  if (operator === "$in" || operator === "$nin") {
    const values = filterValue as unknown[];
    for (const val of values) {
      if (
        typeof val === "boolean" ||
        !["string", "number"].includes(typeof val)
      ) {
        throw new Error(`Unsupported type for value: ${JSON.stringify(val)}`);
      }
    }
    const placeholder = ctx.params.add(values);
    return operator === "$in"
      ? `${fieldSelector} = ANY(${placeholder})`
      : `${fieldSelector} <> ALL(${placeholder})`;
  }

  if (operator === "$like" || operator === "$ilike") {
    const placeholder = ctx.params.add(filterValue);
    return operator === "$like"
      ? `(${fieldSelector} LIKE ${placeholder})`
      : `(${fieldSelector} ILIKE ${placeholder})`;
  }

  if (operator === "$exists") {
    if (typeof filterValue !== "boolean") {
      throw new Error(
        `Expected a boolean value for $exists operator, but got: ${filterValue}`,
      );
    }
    return filterValue
      ? `(${fieldSelector} IS NOT NULL)`
      : `(${fieldSelector} IS NULL)`;
  }

  throw new Error(`Unsupported operator: ${operator}`);
}

/**
 * Combine a LangChain-style metadata filter dictionary into a SQL `WHERE`
 * fragment, delegating leaf `field: value` pairs to `handleField`.
 *
 * Shared by {@link createFilterClause} (v2, typed-column filters) and the
 * legacy `PGVector` store's JSONB-based filter compiler.
 */
export function combineFilterClause(
  filters: unknown,
  handleField: (field: string, value: unknown) => string,
): string {
  if (
    typeof filters !== "object" ||
    filters === null ||
    Array.isArray(filters)
  ) {
    throw new Error(
      `Invalid type: Expected an object but got type: ${typeof filters}`,
    );
  }

  const entries = Object.entries(filters as Record<string, unknown>);

  if (entries.length === 1) {
    const [key, value] = entries[0];
    if (key.startsWith("$")) {
      const lower = key.toLowerCase();
      if (!["$and", "$or", "$not"].includes(lower)) {
        throw new Error(
          `Invalid filter condition. Expected $and, $or or $not but got: ${key}`,
        );
      }
      if (lower === "$and" || lower === "$or") {
        if (!Array.isArray(value)) {
          throw new Error(
            `Expected a list, but got ${typeof value} for value: ${value}`,
          );
        }
        const op = lower === "$and" ? "AND" : "OR";
        const clauses = value.map((el) => combineFilterClause(el, handleField));
        if (clauses.length > 1) return `(${clauses.join(` ${op} `)})`;
        if (clauses.length === 1) return clauses[0];
        throw new Error(
          "Invalid filter condition. Expected a dictionary but got an empty dictionary",
        );
      }
      // $not
      if (Array.isArray(value)) {
        const clauses = value.map((item) =>
          combineFilterClause(item, handleField),
        );
        return `(${clauses.map((c) => `NOT ${c}`).join(" AND ")})`;
      }
      if (typeof value === "object" && value !== null) {
        return `(NOT ${combineFilterClause(value, handleField)})`;
      }
      throw new Error(
        `Invalid filter condition. Expected a dictionary or a list but got: ${typeof value}`,
      );
    }
    return handleField(key, value);
  }

  if (entries.length > 1) {
    for (const [key] of entries) {
      if (key.startsWith("$")) {
        throw new Error(
          `Invalid filter condition. Expected a field but got: ${key}`,
        );
      }
    }
    const clauses = entries.map(([k, v]) => handleField(k, v));
    if (clauses.length > 1) return `(${clauses.join(" AND ")})`;
    if (clauses.length === 1) return clauses[0];
  }

  return "";
}

/** Compile a LangChain metadata filter dictionary into a SQL `WHERE` fragment. */
export function createFilterClause(
  filters: unknown,
  ctx: FilterContext,
): string {
  return combineFilterClause(filters, (field, value) =>
    handleFieldFilter(field, value, ctx),
  );
}
