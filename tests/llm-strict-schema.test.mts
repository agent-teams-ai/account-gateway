import test from "node:test";
import assert from "node:assert/strict";
import {
  LlmSchemaError,
  prepareStrictJsonSchema,
} from "../packages/account-gateway/dist/llm/index.js";

const summary = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    title: { type: "string", maxLength: 3 },
    note: { type: "string" },
    rank: { type: ["integer", "null"], minimum: 1 },
    items: { type: "array", items: { $ref: "#/$defs/item" }, maxItems: 2 },
    kind: { oneOf: [{ const: "news" }, { const: "post" }] },
  },
  required: ["title", "items"],
  $defs: {
    item: {
      type: "object",
      properties: { url: { type: "string", pattern: "^https://" }, score: { type: "number" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
};
const rejection = (code: LlmSchemaError["code"], detail: string) => (error: unknown) =>
  error instanceof LlmSchemaError && error.code === code && error.detail === detail;

const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
const branch = (type: unknown) => ({
  type: "object",
  properties: { a: { type } },
  additionalProperties: false,
});

// Regression: strict mode drops optional members, double-wraps nullable ones or loses $defs and oneOf.
void test("strict form requires every property and adds null only for optional ones", () => {
  const prepared = prepareStrictJsonSchema(summary);
  assert.deepEqual(prepared.schema, {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 3 },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      rank: { type: ["integer", "null"], minimum: 1 },
      items: { type: "array", maxItems: 2, items: { $ref: "#/$defs/item" } },
      kind: { anyOf: [{ anyOf: [{ const: "news" }, { const: "post" }] }, { type: "null" }] },
    },
    required: ["title", "note", "rank", "items", "kind"],
    additionalProperties: false,
    $defs: {
      item: {
        type: "object",
        properties: {
          url: { type: "string", pattern: "^https://" },
          score: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
        required: ["url", "score"],
        additionalProperties: false,
      },
    },
  });
  assert.ok(Object.isFrozen(prepared.schema));
  // A missing additionalProperties is narrowed to false; the original still validates output.
  const open = prepareStrictJsonSchema({ type: "object", properties: { a: { type: "string" } } });
  assert.equal(open.schema.additionalProperties, false);
});

// Regression: decode keeps the nulls strict mode forced, or accepts output outside the original schema.
void test("decode removes added nulls and validates against the original schema", () => {
  const { decode } = prepareStrictJsonSchema(summary);
  assert.deepEqual(
    decode({
      title: "😀ab",
      note: null,
      rank: null,
      items: [{ url: "https://a", score: null }],
      kind: "news",
    }),
    { title: "😀ab", rank: null, items: [{ url: "https://a" }], kind: "news" },
  );
  const valid = { title: "a", note: null, rank: 2, items: [], kind: null };
  const cases: [string, unknown, string][] = [
    ["missing required", { ...valid, title: undefined }, "$.title:required"],
    ["code point bound", { ...valid, title: "abcd" }, "$.title:length"],
    [
      "extra member",
      { ...valid, items: [{ url: "https://a", extra: 1 }] },
      "$.items[0].extra:additionalProperties",
    ],
    ["integer type", { ...valid, rank: 1.5 }, "$.rank:type"],
    ["minimum", { ...valid, rank: 0 }, "$.rank:range"],
    [
      "pattern in $defs",
      { ...valid, items: [{ url: "http://a", score: 1 }] },
      "$.items[0].url:pattern",
    ],
    [
      "array bound",
      { ...valid, items: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] },
      "$.items:items_count",
    ],
    ["enum by oneOf", { ...valid, kind: "other" }, "$.kind:no_alternative"],
  ];
  for (const [name, output, detail] of cases) {
    const value: unknown = JSON.parse(JSON.stringify(output));
    assert.throws(() => decode(value), rejection("output_invalid", detail), name);
  }
});

// Regression: unsupported constructs reach the provider instead of failing as invalid_task.
void test("unsupported schema constructs fail locally with a path-only detail", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "format keyword",
      object({ at: { type: "string", format: "date-time" } }),
      "$.properties.at.format:unsupported_keyword",
    ],
    [
      "open object",
      { ...object({}), additionalProperties: true },
      "$.additionalProperties:only_false_supported",
    ],
    [
      "type union",
      object({ v: { type: ["string", "number"] } }),
      "$.properties.v.type:only_single_or_nullable_type",
    ],
    [
      "remote ref",
      object({ v: { $ref: "https://example.com/schema" } }),
      "$.properties.v.$ref:only_local_defs",
    ],
    [
      "free-form object",
      object({ v: { type: "object" } }),
      "$.properties.v.properties:object_type_with_properties_required",
    ],
    [
      "nested $defs",
      object({ v: { ...object({}), $defs: {} } }),
      "$.properties.v.$defs:unsupported_keyword",
    ],
    [
      "invalid pattern",
      object({ v: { type: "string", pattern: "(" } }),
      "$.properties.v.pattern:invalid_pattern",
    ],
    [
      "unknown required",
      { ...object({}), required: ["v"] },
      "$.required:expected_unique_property_names",
    ],
    ["array root", { type: "array", items: { type: "string" } }, "$:root_must_be_object"],
    [
      "cyclic root",
      { $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/a" } } },
      "$.$ref:cyclic_reference",
    ],
    [
      "older dialect",
      { ...object({}), $schema: "http://json-schema.org/draft-07/schema#" },
      "$.$schema:only_draft_2020_12",
    ],
  ];
  for (const [name, schema, detail] of cases) {
    assert.throws(() => prepareStrictJsonSchema(schema), rejection("invalid_task", detail), name);
  }
  assert.throws(
    () => prepareStrictJsonSchema(object({ v: { type: "string", format: "sensitive-value" } })),
    (error: unknown) =>
      error instanceof LlmSchemaError &&
      !error.message.includes("sensitive-value") &&
      !error.detail.includes("sensitive-value"),
  );
});

// Regression: an output matching two alternatives is silently resolved to either branch.
void test("ambiguous alternatives are rejected rather than guessed", () => {
  const { decode } = prepareStrictJsonSchema({
    type: "object",
    properties: { choice: { anyOf: [branch("string"), branch(["string", "null"])] } },
    required: ["choice"],
  });
  // Both branches agree on a concrete value.
  assert.deepEqual(decode({ choice: { a: "x" } }), { choice: { a: "x" } });
  // null is either an added placeholder or a real value: refuse to guess.
  assert.throws(
    () => decode({ choice: { a: null } }),
    rejection("output_invalid", "$.choice:ambiguous"),
  );
});
