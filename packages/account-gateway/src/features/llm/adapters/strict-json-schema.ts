/**
 * Provider schema for `{ mode: "json_schema", schema }` plus the matching output
 * decoder. Optional properties become required nullable members in strict mode;
 * decode removes those added nulls and validates against the original schema.
 */
export type StrictJsonSchema = {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly decode: (value: unknown) => unknown;
};

/** detail is a schema path and reason only; it never contains schema or output values. */
export class LlmSchemaError extends Error {
  constructor(
    readonly code: "invalid_task" | "output_invalid",
    readonly detail: string,
  ) {
    super(`Account gateway llm schema: ${code}`);
    this.name = "LlmSchemaError";
  }
}

type Schema = Readonly<Record<string, unknown>>;
type Context = {
  readonly defs: Readonly<Record<string, Schema>>;
  readonly patterns: Map<string, RegExp>;
};

const dialect = "https://json-schema.org/draft/2020-12/schema";
const annotations = ["title", "description"];
const scalars = [
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;
const keywords = new Set([
  "$schema",
  "$ref",
  "$defs",
  ...annotations,
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  ...scalars,
]);
const typeNames = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const maxDepth = 64;
/** The facade parses at most 64 JSON levels; the request envelope uses three. */
const maxSchemaDepth = 60;

const record = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (path: string, reason: string): never => {
  throw new LlmSchemaError("invalid_task", `${path}:${reason}`);
};
const rejected = (path: string, reason: string): never => {
  throw new LlmSchemaError("output_invalid", `${path}:${reason}`);
};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Deterministic text for JSON equality (const, enum, uniqueItems, ambiguity). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (record(value)) {
    const keys = Object.keys(value).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Plain JSON copy; accessors, symbols, functions and non-finite numbers are rejected. */
function plain(value: unknown, path: string, depth = 0): unknown {
  if (depth > maxDepth) {
    return invalid(path, "depth_exceeded");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || finite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown, index) =>
      plain(entry, `${path}[${String(index)}]`, depth + 1),
    );
  }
  if (!record(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return invalid(path, "non_json_value");
  }
  return Object.fromEntries(
    Object.keys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return [
        key,
        descriptor && "value" in descriptor
          ? plain(descriptor.value, `${path}.${key}`, depth + 1)
          : invalid(`${path}.${key}`, "non_data_property"),
      ];
    }),
  );
}

function typesOf(schema: Schema, path: string): readonly string[] {
  if (schema.type === undefined) {
    return [];
  }
  const list: unknown[] = Array.isArray(schema.type) ? (schema.type as unknown[]) : [schema.type];
  if (
    list.length === 0 ||
    list.some((entry) => typeof entry !== "string" || !typeNames.has(entry)) ||
    new Set(list).size !== list.length ||
    (list.length > 1 && (list.length !== 2 || !list.includes("null")))
  ) {
    return invalid(`${path}.type`, "only_single_or_nullable_type");
  }
  return list as string[];
}

function target(ctx: Context, reference: unknown, path: string): Schema {
  const name =
    typeof reference === "string" && reference.startsWith("#/$defs/") ? reference.slice(8) : "";
  const decoded = name.replaceAll("~1", "/").replaceAll("~0", "~");
  const schema = Object.hasOwn(ctx.defs, decoded) ? ctx.defs[decoded] : undefined;
  return schema ?? invalid(`${path}.$ref`, "only_local_defs");
}

const siblings = (schema: Schema, allowed: readonly string[]) =>
  Object.keys(schema).every((key) => allowed.includes(key));

/** Structural checks; every subschema is checked once and $ref is never followed here. */
function check(ctx: Context, schema: Schema, path: string, depth: number): void {
  if (depth > maxDepth) {
    invalid(path, "depth_exceeded");
  }
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key) || ((key === "$schema" || key === "$defs") && path !== "$")) {
      invalid(`${path}.${key}`, "unsupported_keyword");
    }
  }
  for (const key of annotations) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      invalid(`${path}.${key}`, "expected_string");
    }
  }
  const root = path === "$" ? ["$schema", "$defs"] : [];
  if (schema.$ref !== undefined) {
    target(ctx, schema.$ref, path);
    if (!siblings(schema, ["$ref", ...annotations, ...root])) {
      invalid(`${path}.$ref`, "unsupported_siblings");
    }
    return;
  }
  const composite = schema.anyOf === undefined ? "oneOf" : "anyOf";
  const branches = schema[composite];
  if (branches !== undefined) {
    if (
      !Array.isArray(branches) ||
      branches.length === 0 ||
      !siblings(schema, [composite, ...annotations, ...root])
    ) {
      invalid(`${path}.${composite}`, "expected_lone_non_empty_array");
    }
    (branches as unknown[]).forEach((branch, index) => {
      const at = `${path}.${composite}[${String(index)}]`;
      check(ctx, record(branch) ? branch : invalid(at, "expected_schema"), at, depth + 1);
    });
    return;
  }
  const types = typesOf(schema, path);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    invalid(`${path}.enum`, "expected_non_empty_array");
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (schema[key] !== undefined && !count(schema[key])) {
      invalid(`${path}.${key}`, "expected_count");
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (schema[key] !== undefined && !finite(schema[key])) {
      invalid(`${path}.${key}`, "expected_number");
    }
  }
  if (schema.multipleOf !== undefined && !(finite(schema.multipleOf) && schema.multipleOf > 0)) {
    invalid(`${path}.multipleOf`, "expected_positive_number");
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    invalid(`${path}.uniqueItems`, "expected_boolean");
  }
  if (schema.pattern !== undefined) {
    try {
      if (typeof schema.pattern !== "string") {
        throw new TypeError("pattern");
      }
      ctx.patterns.set(schema.pattern, new RegExp(schema.pattern, "u"));
    } catch {
      invalid(`${path}.pattern`, "invalid_pattern");
    }
  }
  const objectLike = types.includes("object");
  if (objectLike || schema.properties !== undefined || schema.required !== undefined) {
    const properties =
      record(schema.properties) && objectLike
        ? schema.properties
        : invalid(`${path}.properties`, "object_type_with_properties_required");
    const required: unknown = schema.required ?? [];
    if (
      !Array.isArray(required) ||
      new Set(required).size !== required.length ||
      required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))
    ) {
      invalid(`${path}.required`, "expected_unique_property_names");
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      invalid(`${path}.additionalProperties`, "only_false_supported");
    }
    for (const [key, property] of Object.entries(properties)) {
      const at = `${path}.properties.${key}`;
      check(ctx, record(property) ? property : invalid(at, "expected_schema"), at, depth + 1);
    }
  } else if (schema.additionalProperties !== undefined) {
    invalid(`${path}.additionalProperties`, "object_type_required");
  }
  if (types.includes("array") || schema.items !== undefined) {
    const at = `${path}.items`;
    check(
      ctx,
      record(schema.items) && types.includes("array")
        ? schema.items
        : invalid(at, "array_type_with_single_items_required"),
      at,
      depth + 1,
    );
  }
}

/** First violation as path:keyword, or undefined when the value conforms. */
function violation(
  ctx: Context,
  schema: Schema,
  value: unknown,
  path: string,
  depth: number,
): string | undefined {
  if (depth > maxDepth) {
    return `${path}:depth_exceeded`;
  }
  if (schema.$ref !== undefined) {
    return violation(ctx, target(ctx, schema.$ref, path), value, path, depth + 1);
  }
  const composite = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (composite) {
    const matched = (composite as Schema[]).filter(
      (branch) => violation(ctx, branch, value, path, depth + 1) === undefined,
    ).length;
    return matched === 0 || (schema.oneOf !== undefined && matched > 1)
      ? `${path}:${schema.oneOf === undefined ? "anyOf" : "oneOf"}`
      : undefined;
  }
  const types = typesOf(schema, path);
  const kind =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number"
          ? Number.isInteger(value)
            ? "integer"
            : "number"
          : typeof value === "object"
            ? "object"
            : typeof value;
  if (
    types.length > 0 &&
    !types.includes(kind) &&
    !(kind === "integer" && types.includes("number"))
  ) {
    return `${path}:type`;
  }
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) {
    return `${path}:const`;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry: unknown) => canonical(entry) === canonical(value))
  ) {
    return `${path}:enum`;
  }
  if (typeof value === "string") {
    // JSON Schema lengths count code points, not UTF-16 units.
    const length = Array.from(value).length;
    const pattern =
      typeof schema.pattern === "string" ? ctx.patterns.get(schema.pattern) : undefined;
    if (
      (count(schema.minLength) && length < schema.minLength) ||
      (count(schema.maxLength) && length > schema.maxLength)
    ) {
      return `${path}:length`;
    }
    if (pattern && !pattern.test(value)) {
      return `${path}:pattern`;
    }
  }
  if (typeof value === "number") {
    if (
      (finite(schema.minimum) && value < schema.minimum) ||
      (finite(schema.maximum) && value > schema.maximum) ||
      (finite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) ||
      (finite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) ||
      (finite(schema.multipleOf) && !Number.isInteger(value / schema.multipleOf))
    ) {
      return `${path}:range`;
    }
  }
  if (Array.isArray(value)) {
    if (
      (count(schema.minItems) && value.length < schema.minItems) ||
      (count(schema.maxItems) && value.length > schema.maxItems)
    ) {
      return `${path}:items_count`;
    }
    if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) {
      return `${path}:uniqueItems`;
    }
    if (record(schema.items)) {
      for (const [index, item] of (value as unknown[]).entries()) {
        const found = violation(ctx, schema.items, item, `${path}[${String(index)}]`, depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
    }
  }
  if (record(value) && record(schema.properties)) {
    const properties = schema.properties;
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!Object.hasOwn(value, key)) {
        return `${path}.${key}:required`;
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (!record(property)) {
        if (schema.additionalProperties === false) {
          return `${path}.${key}:additionalProperties`;
        }
        continue;
      }
      const found = violation(ctx, property, item, `${path}.${key}`, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/** Strict provider form: every property required, added nulls for optional ones. */
function strict(ctx: Context, schema: Schema): Schema {
  const out: Record<string, unknown> = {};
  for (const key of [...annotations, "$ref", "type", "const", "enum", ...scalars]) {
    if (schema[key] !== undefined) {
      out[key] = schema[key];
    }
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    out.anyOf = (branches as Schema[]).map((branch) => strict(ctx, branch));
  }
  if (record(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const properties = Object.entries(schema.properties as Record<string, Schema>);
    out.properties = Object.fromEntries(
      properties.map(([key, property]) => {
        const transformed = strict(ctx, property);
        const keep = required.has(key) || violation(ctx, property, null, "$", 0) === undefined;
        return [key, keep ? transformed : { anyOf: [transformed, { type: "null" }] }];
      }),
    );
    out.required = properties.map(([key]) => key);
    out.additionalProperties = false;
  }
  if (record(schema.items)) {
    out.items = strict(ctx, schema.items);
  }
  return out;
}

/** Removes nulls the strict form added; a value matching several alternatives is ambiguous. */
function normalize(
  ctx: Context,
  schema: Schema,
  value: unknown,
  path: string,
  depth: number,
): unknown {
  if (depth > maxDepth) {
    return rejected(path, "depth_exceeded");
  }
  if (schema.$ref !== undefined) {
    return normalize(ctx, target(ctx, schema.$ref, path), value, path, depth + 1);
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    const candidates = new Map<string, unknown>();
    for (const branch of branches as Schema[]) {
      let candidate: unknown;
      try {
        candidate = normalize(ctx, branch, value, path, depth + 1);
      } catch (error) {
        if (error instanceof LlmSchemaError && error.detail.endsWith(":ambiguous")) {
          throw error;
        }
        continue;
      }
      if (violation(ctx, branch, candidate, path, depth + 1) === undefined) {
        candidates.set(canonical(candidate), candidate);
      }
    }
    if (candidates.size !== 1) {
      return rejected(path, candidates.size === 0 ? "no_alternative" : "ambiguous");
    }
    return [...candidates.values()][0];
  }
  if (record(value) && record(schema.properties)) {
    const properties = schema.properties;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (!record(property)) {
        entries.push([key, item]);
      } else if (
        item !== null ||
        required.has(key) ||
        violation(ctx, property, null, path, depth) === undefined
      ) {
        entries.push([key, normalize(ctx, property, item, `${path}.${key}`, depth + 1)]);
      }
    }
    return Object.fromEntries(entries);
  }
  if (Array.isArray(value) && record(schema.items)) {
    const items = schema.items;
    return value.map((item: unknown, index) =>
      normalize(ctx, items, item, `${path}[${String(index)}]`, depth + 1),
    );
  }
  return value;
}

function depthOf(value: unknown): number {
  return Array.isArray(value) || record(value)
    ? 1 + Math.max(0, ...Object.values(value).map(depthOf))
    : 0;
}

function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

/**
 * Prepares a consumer JSON Schema for OpenAI-style strict structured output. The
 * keyword allowlist matches what Codex strict mode accepts in practice; anything
 * else throws LlmSchemaError("invalid_task") synchronously.
 */
export function prepareStrictJsonSchema(
  schema: Readonly<Record<string, unknown>>,
): StrictJsonSchema {
  const root = plain(schema, "$");
  if (!record(root)) {
    return invalid("$", "expected_schema");
  }
  if (root.$schema !== undefined && root.$schema !== dialect) {
    invalid("$.$schema", "only_draft_2020_12");
  }
  const rawDefs = root.$defs ?? {};
  if (!record(rawDefs) || !Object.values(rawDefs).every(record)) {
    return invalid("$.$defs", "expected_schema_map");
  }
  const ctx: Context = { defs: rawDefs as Record<string, Schema>, patterns: new Map() };
  check(ctx, root, "$", 0);
  for (const [name, definition] of Object.entries(ctx.defs)) {
    check(ctx, definition, `$.$defs.${name}`, 1);
  }
  let resolved: Schema = root;
  for (
    const seen = new Set<unknown>();
    resolved.$ref !== undefined;
    resolved = target(ctx, resolved.$ref, "$")
  ) {
    if (seen.has(resolved.$ref)) {
      return invalid("$.$ref", "cyclic_reference");
    }
    seen.add(resolved.$ref);
  }
  if (resolved.type !== "object") {
    invalid("$", "root_must_be_object");
  }
  const provider: Record<string, unknown> = { ...strict(ctx, root) };
  if (Object.keys(ctx.defs).length > 0) {
    provider.$defs = Object.fromEntries(
      Object.entries(ctx.defs).map(([name, definition]) => [name, strict(ctx, definition)]),
    );
  }
  if (depthOf(provider) > maxSchemaDepth) {
    invalid("$", "depth_exceeded");
  }
  return Object.freeze({
    schema: frozen(provider),
    decode(value: unknown): unknown {
      const normalized = normalize(ctx, root, value, "$", 0);
      const found = violation(ctx, root, normalized, "$", 0);
      if (found !== undefined) {
        throw new LlmSchemaError("output_invalid", found);
      }
      return normalized;
    },
  });
}
