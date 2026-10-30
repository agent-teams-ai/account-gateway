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
