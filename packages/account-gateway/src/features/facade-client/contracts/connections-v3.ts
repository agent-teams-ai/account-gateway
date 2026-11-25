import { z } from "zod";
import { reference, revision, deadline } from "./primitives.js";
import { accountOperation, qualifiedModelCapability } from "./core.js";

export const PROVIDER_CONNECTIONS_V3_CONTRACT = "provider-connections/v3" as const;
export const CONNECTION_INPUT_BYTES = 65_536;
export const CONNECTION_REQUIRED_CAPABILITIES = Object.freeze([
  "owner_scoped_custody/v1",
  "effect_fence/v1",
  "native_dispatch/v1",
] as const);
const identity = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
const profileId = reference.max(64);
const label = z.string().min(1).max(128);
const semanticRevision = revision.min(1);
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;

export const connectionBinding = z.strictObject({
  profileId,
  methodId: identity,
  methodRevision: semanticRevision,
  configurationGeneration: reference,
});
export const credentialPolicy = z.enum([
  "provider_key",
  "subscription_session",
  "cloud_identity",
  "delegated_identity",
]);
export const credentialAttestation = z.strictObject({
  credentialKind: z.enum(["api_key", "oauth", "native"]),
  credentialPolicy,
  refreshPolicy: z.enum(["native", "none"]),
});

const fieldMembers = {
  fieldId: identity,
  label,
  required: z.boolean(),
  maxBytes: z.number().int().min(1).max(CONNECTION_INPUT_BYTES),
  help: z.string().min(1).max(512).optional(),
};
const choice = z.strictObject({ value: z.string().min(1).max(256), label });
export const connectionInputField = z.discriminatedUnion("kind", [
  z.strictObject({ ...fieldMembers, kind: z.literal("text") }),
  z.strictObject({ ...fieldMembers, kind: z.literal("secret") }),
  z.strictObject({ ...fieldMembers, kind: z.literal("document") }),
  z.strictObject({
    ...fieldMembers,
    kind: z.literal("select"),
    choices: z
      .array(choice)
      .min(1)
      .max(64)
      .refine((v) => distinct(v.map((c) => c.value))),
  }),
]);
function interactionWith<T extends z.ZodType<{ fieldId: string }>>(field: T) {
  const fields = z
    .array(field)
    .min(1)
    .max(16)
    .refine((v) => distinct(v.map((f) => f.fieldId)));
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("browser"),
      preflightFields: fields.optional(),
      callbackMode: z.enum(["automatic", "manual"]),
      completionInputKind: z.enum(["callback_url", "authorization_code"]),
    }),
    z.strictObject({ kind: z.literal("device"), preflightFields: fields.optional() }),
    z.strictObject({ kind: z.literal("credential_form"), inputFields: fields }),
  ]);
}
export const connectionInteraction = interactionWith(connectionInputField);

// Only unknown primitives take the opaque branch. Known malformed shapes never
// fall through it. The enclosing descriptor remains strict and byte bounded.
function boundedOpaque(value: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return !/\p{Cs}/u.test(value) && value.length <= 2048;
  }
  if (Array.isArray(value)) {
    return value.length <= 64 && value.every((v) => boundedOpaque(v, depth + 1));
  }
  if (typeof value !== "object") {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= 32 &&
    entries.every(([k, v]) => k.length <= 128 && boundedOpaque(v, depth + 1))
  );
}
const unknownInteraction = z
  .looseObject({
    kind: identity.refine((v) => !["browser", "device", "credential_form"].includes(v)),
  })
  .refine((v) => boundedOpaque(v) && new TextEncoder().encode(JSON.stringify(v)).length <= 8192);
const unknownField = z
  .looseObject({
    ...fieldMembers,
    kind: identity.refine((v) => !["text", "secret", "document", "select"].includes(v)),
  })
  .refine((v) => boundedOpaque(v) && new TextEncoder().encode(JSON.stringify(v)).length <= 8192);
const envelopeInteraction = interactionWith(z.union([connectionInputField, unknownField]));
const methodMembers = {
  methodId: identity,
  revision: semanticRevision,
  configurationGeneration: reference,
  label,
  create: z.boolean(),
  reconnect: z.boolean(),
  // Open at the envelope boundary: unknown requirements disable only this method.
  allowedCredentialPolicies: z.array(identity).min(1).max(8).refine(distinct),
  requirements: z
    .array(z.string().regex(/^[a-z][a-z0-9_-]{0,95}\/v[1-9][0-9]{0,3}$/))
    .min(1)
    .max(16)
    .refine(distinct),
  availability: z.enum(["enabled", "deployment_configuration_required"]),
  reason: identity.optional(),
};
export const connectionMethodV3 = z.strictObject({
  ...methodMembers,
  interaction: z.union([envelopeInteraction, unknownInteraction]),
});
export const supportedConnectionMethodV3 = z.strictObject({
  ...methodMembers,
  allowedCredentialPolicies: z.array(credentialPolicy).min(1).max(4).refine(distinct),
  requirements: z.array(z.enum(CONNECTION_REQUIRED_CAPABILITIES)).length(3).refine(distinct),
  interaction: connectionInteraction,
});
export function supportsConnectionMethod(
  input: ConnectionMethodV3,
): input is SupportedConnectionMethodV3 {
  return supportedConnectionMethodV3.safeParse(input).success;
}

export const nativeModelPolicy = z.strictObject({
  contract: z.literal("native-account-models/v2"),
  sourceId: identity,
  unavailableFallback: z.enum(["deny", "qualified_anchor"]),
});
export const connectionProfileV3 = z.strictObject({
  profileId,
  provider: z.strictObject({ id: identity, label }),
  product: z.strictObject({ id: identity, label }),
  region: z.strictObject({ id: identity, label }),
  protocol: z.literal("openai-responses"),
  models: z
    .array(qualifiedModelCapability)
    .min(1)
    .max(512)
    .refine((v) => distinct(v.map((m) => m.modelId))),
  modelPolicy: nativeModelPolicy,
  methods: z
    .array(connectionMethodV3)
    .max(32)
    .refine((v) => distinct(v.map((m) => m.methodId))),
  accountInfo: z.boolean(),
  limitsContract: z.enum([
    "account-limits/v3",
    "account-limits/v2",
    "account-limits/v1",
    "unsupported",
  ]),
  availability: z.enum(["enabled", "deployment_configuration_required"]),
});
export const providerConnectionCapabilitiesV3 = z.strictObject({
  contract: z.literal(PROVIDER_CONNECTIONS_V3_CONTRACT),
  capabilities: z
    .array(connectionProfileV3)
    .max(128)
    .refine((v) => distinct(v.map((p) => p.profileId))),
});

// Persisted safe recovery context. Challenges and all submitted values are absent.
export const connectionSnapshot = z
  .strictObject({
    connection: connectionBinding,
    method: supportedConnectionMethodV3,
    credential: credentialAttestation.optional(),
  })
  .refine(
    (v) =>
      v.connection.methodId === v.method.methodId &&
      v.connection.methodRevision === v.method.revision &&
      v.connection.configurationGeneration === v.method.configurationGeneration &&
      (v.credential === undefined ||
        v.method.allowedCredentialPolicies.includes(v.credential.credentialPolicy)),
  );
export const connectionOperation = z.strictObject({
  operation: accountOperation,
  connection: connectionSnapshot.nullable(),
});
const handoffURL = z
  .string()
  .max(4096)
  .check(z.url())
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
export const connectionChallenge = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser"), authorizationURL: handoffURL }),
  z.strictObject({
    kind: z.literal("device"),
    userCode: z.string().min(1).max(128),
    verificationURL: handoffURL,
    expiresAt: deadline,
    intervalSeconds: z.number().int().min(1).max(300),
  }),
]);
export const connectionBeginResponse = connectionOperation
  .extend({
    connection: connectionSnapshot,
    challenge: connectionChallenge.optional(),
  })
  .refine(
    (v) =>
      v.challenge === undefined ||
      (v.operation.state === "pending" &&
        v.challenge.kind === v.connection.method.interaction.kind),
  );
export const connectionOperationRequest = z.strictObject({
  operationId: reference,
  ownerRef: reference,
});

export type ConnectionBinding = z.infer<typeof connectionBinding>;
export type CredentialPolicy = z.infer<typeof credentialPolicy>;
export type CredentialAttestation = z.infer<typeof credentialAttestation>;
export type ConnectionInputField = z.infer<typeof connectionInputField>;
export type ConnectionInteraction = z.infer<typeof connectionInteraction>;
export type ConnectionMethodV3 = z.infer<typeof connectionMethodV3>;
export type SupportedConnectionMethodV3 = z.infer<typeof supportedConnectionMethodV3>;
export type ConnectionProfileV3 = z.infer<typeof connectionProfileV3>;
export type ProviderConnectionCapabilitiesV3 = z.infer<typeof providerConnectionCapabilitiesV3>;
export type ConnectionSnapshot = z.infer<typeof connectionSnapshot>;
export type ConnectionOperation = z.infer<typeof connectionOperation>;
export type ConnectionBeginResponse = z.infer<typeof connectionBeginResponse>;
export type ConnectionOperationRequest = z.infer<typeof connectionOperationRequest>;
