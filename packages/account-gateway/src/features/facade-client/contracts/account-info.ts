import { z } from "zod";
import { deadline, reference, revision } from "./primitives.js";

export const ACCOUNT_INFO_CONTRACT = "account-info/v1" as const;
export const ACCOUNT_INFO_V2_CONTRACT = "account-info/v2" as const;
export const ACCOUNT_INFO_MAX_REFS = 50;
export const ACCOUNT_INFO_REQUEST_BYTES = 16 * 1024;
export const ACCOUNT_INFO_RESULT_BYTES = 8 * 1024;
export const ACCOUNT_INFO_RESPONSE_BYTES = 512 * 1024;

const bytesWithin = (value: unknown, maximum: number): boolean =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum * 2)
    .refine((value) => Array.from(value).length <= maximum && !/[\p{Cc}\p{Cs}]/u.test(value));
export const accountInfoSource = z.enum([
  "provider_api",
  "verified_claim",
  "imported",
  "user_supplied",
  "inferred",
]);
const absentFact = z.strictObject({ status: z.enum(["unknown", "unsupported", "unavailable"]) });
const fact = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("known"),
      value,
      source: accountInfoSource,
      observedAt: deadline,
      freshness: z.enum(["current", "stale"]),
    }),
    absentFact,
  ]);
export const accountInfoSubscriptionEnd = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instant"), value: deadline }),
  z.strictObject({ kind: z.literal("date"), value: z.iso.date() }),
]);
export const accountInfoSubscription = z.strictObject({
  code: text(100),
  label: text(160),
  scope: z.enum(["personal", "organization", "workspace", "unknown"]),
  endsAt: accountInfoSubscriptionEnd.nullable(),
});
export const accountInfoFields = z.strictObject({
  email: fact(text(320)),
  accountLabel: fact(text(200)),
  subscription: fact(accountInfoSubscription),
  credentialExpiresAt: fact(deadline),
  privacyMode: fact(z.enum(["private", "public"])),
});
export const accountInfo = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("available"),
      infoRevision: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\x21-\x7e]+$/),
      fields: accountInfoFields,
    }),
    z.strictObject({ status: z.enum(["unavailable", "unsupported"]) }),
  ])
  .refine((value) => bytesWithin(value, ACCOUNT_INFO_RESULT_BYTES));
export const accountInfoReadRequest = z
  .strictObject({
    ownerRef: reference,
    accountRefs: z
      .array(reference)
      .min(1)
      .max(ACCOUNT_INFO_MAX_REFS)
      .refine((values) => new Set(values).size === values.length),
  })
  .refine((value) => bytesWithin(value, ACCOUNT_INFO_REQUEST_BYTES));
export const accountInfoAccount = z.strictObject({
  accountRef: reference,
  metadataRevision: revision,
  authorizationEpoch: revision,
  info: accountInfo,
});
export const accountInfoReadResponse = z
  .strictObject({
    contract: z.literal(ACCOUNT_INFO_CONTRACT),
    accounts: z
      .array(accountInfoAccount)
      .max(ACCOUNT_INFO_MAX_REFS)
      .refine((values) => new Set(values.map((value) => value.accountRef)).size === values.length),
  })
  .refine((value) => bytesWithin(value, ACCOUNT_INFO_RESPONSE_BYTES));

export type AccountInfo = z.infer<typeof accountInfo>;
export type AccountInfoFields = z.infer<typeof accountInfoFields>;
export type AccountInfoSource = z.infer<typeof accountInfoSource>;
export type AccountInfoSubscription = z.infer<typeof accountInfoSubscription>;
export type AccountInfoSubscriptionEnd = z.infer<typeof accountInfoSubscriptionEnd>;
export type AccountInfoReadRequest = z.infer<typeof accountInfoReadRequest>;
export type AccountInfoReadResponse = z.infer<typeof accountInfoReadResponse>;
export type AccountInfoAccount = z.infer<typeof accountInfoAccount>;

// A finite second projection: training consent is not a general privacy label.
// Shared field/status bounds remain identical; v1 strict readers stay unchanged.
export const accountInfoFieldsV2 = accountInfoFields.omit({ privacyMode: true }).extend({
  trainingUsage: fact(z.enum(["enabled", "disabled"])),
});
export const accountInfoV2 = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("available"),
      infoRevision: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\x21-\x7e]+$/),
      fields: accountInfoFieldsV2,
    }),
    z.strictObject({ status: z.enum(["unavailable", "unsupported"]) }),
  ])
  .refine((value) => bytesWithin(value, ACCOUNT_INFO_RESULT_BYTES));
export const accountInfoAccountV2 = accountInfoAccount.omit({ info: true }).extend({
  info: accountInfoV2,
});
export const accountInfoReadResponseV2 = z
  .strictObject({
    contract: z.literal(ACCOUNT_INFO_V2_CONTRACT),
    accounts: z
      .array(accountInfoAccountV2)
      .max(ACCOUNT_INFO_MAX_REFS)
      .refine((values) => new Set(values.map((value) => value.accountRef)).size === values.length),
  })
  .refine((value) => bytesWithin(value, ACCOUNT_INFO_RESPONSE_BYTES));

export type AccountInfoV2 = z.infer<typeof accountInfoV2>;
export type AccountInfoFieldsV2 = z.infer<typeof accountInfoFieldsV2>;
export type AccountInfoAccountV2 = z.infer<typeof accountInfoAccountV2>;
export type AccountInfoReadResponseV2 = z.infer<typeof accountInfoReadResponseV2>;

/** Explicit old-source adapter; failures never trigger protocol fallback. */
export function accountInfoFromV1(value: AccountInfo): AccountInfoV2 {
  if (value.status !== "available") {
    return value;
  }
  const { privacyMode: _legacyPrivacy, ...fields } = value.fields;
  return { ...value, fields: { ...fields, trainingUsage: { status: "unsupported" } } };
}

export function accountInfoToV1(value: AccountInfoV2): AccountInfo {
  if (value.status !== "available") {
    return value;
  }
  const { trainingUsage: _trainingUsage, ...fields } = value.fields;
  return { ...value, fields: { ...fields, privacyMode: { status: "unsupported" } } };
}
