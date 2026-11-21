import { z } from "zod";
import { reference } from "./primitives.js";
import { limitsWindow } from "./limits-window.js";
import {
  qualifiedModelCapability,
  accountLimitsV2,
  usageObservation,
} from "./index.js";

const identity = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
const instant = z.iso.datetime({ offset: true }).max(64);
const unavailable = [
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({ status: z.literal("unsupported") }),
  z.strictObject({ status: z.literal("unavailable") }),
] as const;

export const NATIVE_ACCOUNT_MODELS_V2_CONTRACT = "native-account-models/v2" as const;
export const accountModelsV2 = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("snapshot"),
    sourceId: identity,
    profileId: reference.max(64),
    physicalGeneration: reference,
    principalVersion: reference,
    fetchedAt: instant,
    expiresAt: instant,
    admission: z.strictObject({ unavailableFallback: z.enum(["deny", "qualified_anchor"]) }),
    models: z.array(qualifiedModelCapability).max(512)
      .refine((v) => new Set(v.map((m) => m.modelId)).size === v.length),
  }).refine((v) => Date.parse(v.fetchedAt) < Date.parse(v.expiresAt)),
  ...unavailable,
]);

export const ACCOUNT_LIMITS_V3_CONTRACT = "account-limits/v3" as const;
export const accountLimitsV3Capabilities = z.strictObject({
  contract: z.literal(ACCOUNT_LIMITS_V3_CONTRACT),
  cachedRead: z.boolean(),
  quotaOnlyRefresh: z.literal(false),
});
// The existing canonical dimension/unit/period refinements stay identical.
// Only provider identity is open in this separately negotiated contract.
const window = limitsWindow(identity);
export const accountLimitsV3 = z.discriminatedUnion("status", [
  accountLimitsV2.options[0].extend({
    windows: z.array(window).min(1).max(8).refine((v) =>
      new Set(v.map((w) => [w.provider, w.id, w.dimension, w.unit].join(":"))).size === v.length),
  }),
  ...unavailable,
]);

export const nativeBillingObservation = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({
    status: z.literal("known"),
    kind: z.enum(["subscription", "credits", "free", "payg", "mixed"]),
  }),
]);
export const nativeUsageContext = z.strictObject({
  providerId: identity,
  productId: identity,
  profileId: reference.max(64),
  modelId: z.string().min(1).max(128),
  billing: nativeBillingObservation,
});
export const observedUsageCost = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountDecimal: z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/),
});
export const usageObservationV2 = usageObservation.extend({
  schemaVersion: z.literal(2),
  nativeContext: nativeUsageContext.nullable(),
  cost: observedUsageCost.nullable(),
}).refine((v) => v.nativeContext === null ||
  (v.nativeContext.profileId === v.profileId && v.nativeContext.modelId === v.model));
export const usagePageV2 = z.strictObject({
  observations: z.array(usageObservationV2).max(100),
  nextCursor: z.string().max(512),
  highWaterCursor: z.string().max(512),
});
export const usageReadV2 = z.strictObject({ observation: usageObservationV2.nullable() });

/** Historical rows keep their written version; projection never guesses context. */
export function projectUsageV2(input: z.infer<typeof usageObservation> | UsageObservationV2): UsageObservationV2 {
  return input.schemaVersion === 2
    ? usageObservationV2.parse(input)
    : usageObservationV2.parse({ ...input, schemaVersion: 2, nativeContext: null });
}
export function projectUsageV1(input: z.infer<typeof usageObservation> | UsageObservationV2) {
  if (input.schemaVersion === 1) return usageObservation.parse(input);
  const { nativeContext: _context, ...common } = usageObservationV2.parse(input);
  return usageObservation.parse({ ...common, schemaVersion: 1, cost: null });
}

export type AccountModelsV2 = z.infer<typeof accountModelsV2>;
export type AccountLimitsV3Capabilities = z.infer<typeof accountLimitsV3Capabilities>;
export type AccountLimitsV3 = z.infer<typeof accountLimitsV3>;
export type NativeUsageContext = z.infer<typeof nativeUsageContext>;
export type ObservedUsageCost = z.infer<typeof observedUsageCost>;
export type UsageObservationV2 = z.infer<typeof usageObservationV2>;
export type UsagePageV2 = z.infer<typeof usagePageV2>;
