import { z } from "zod";
import { reference, revision } from "../contracts/primitives.js";
import {
  connectionBinding,
  CONNECTION_INPUT_BYTES,
  type ConnectionInputField,
} from "../contracts/connections-v3.js";

const fieldId = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
/** Every value is sensitive; never export this envelope through a safe DTO. */
export const connectionInputFields = z.record(fieldId, z.string().refine((v) => !/\p{Cs}/u.test(v)))
  .refine((v) => Object.keys(v).length <= 16 &&
    new TextEncoder().encode(JSON.stringify(v)).length <= CONNECTION_INPUT_BYTES);
export const connectionBegin = z.strictObject({
  operationId: reference,
  ownerRef: reference,
  displayName: z.string().min(1).max(128),
  connection: connectionBinding,
  inputFields: connectionInputFields.optional(),
});
export const connectionReconnect = z.strictObject({
  operationId: reference,
  expectedMetadataRevision: revision,
  connection: connectionBinding,
  inputFields: connectionInputFields.optional(),
});
export const connectionSubmit = z.strictObject({
  operationId: reference,
  ownerRef: reference,
  inputFields: connectionInputFields,
});
/** Bounds and declared field membership only; native owns all credential grammar. */
export function validateConnectionFields(
  fields: readonly ConnectionInputField[],
  input: Record<string, string> | undefined,
): boolean {
  const parsed = connectionInputFields.safeParse(input ?? {});
  if (!parsed.success) return false;
  const allowed = new Map(fields.map((field) => [field.fieldId, field]));
  if (Object.keys(parsed.data).some((key) => !allowed.has(key))) return false;
  return fields.every((field) => {
    const value = parsed.data[field.fieldId];
    if (value === undefined) return !field.required;
    if (field.required && value.length === 0) return false;
    if (new TextEncoder().encode(value).length > field.maxBytes) return false;
    return field.kind !== "select" || field.choices.some((choice) => choice.value === value);
  });
}
export type ConnectionBegin = z.infer<typeof connectionBegin>;
export type ConnectionReconnect = z.infer<typeof connectionReconnect>;
export type ConnectionSubmit = z.infer<typeof connectionSubmit>;
