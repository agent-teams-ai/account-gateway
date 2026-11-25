import { z } from "zod";
import { reference } from "./primitives.js";
import { lifecycleAccount, lifecycleCapability, lifecycleOperation } from "./core.js";
import { credentialAttestation } from "./connections-v3.js";

export const LIFECYCLE_V3_CAPABILITY_CONTRACT = "account-gateway/account-lifecycle/v3" as const;
export const LIFECYCLE_V3_CLIENT_CONTRACT = "account-gateway-client/account-lifecycle/v3" as const;
export const lifecycleCapabilityV3 = lifecycleCapability.extend({
  contract: z.literal(LIFECYCLE_V3_CAPABILITY_CONTRACT),
  clientContract: z.literal(LIFECYCLE_V3_CLIENT_CONTRACT),
  custody: z.strictObject({
    contract: z.literal("native-retained-custody/v2"),
    api_key: z.literal("native-attestation-required"),
    oauth: z.literal("native-attestation-required"),
    native: z.literal("native-attestation-required"),
  }),
});
export const lifecycleAccountV3 = lifecycleAccount
  .extend({
    authKind: z.enum(["api_key", "oauth", "native", "unknown"]),
    credential: credentialAttestation.optional(),
  })
  .refine((v) =>
    v.credential === undefined
      ? v.authKind !== "native"
      : v.credential.credentialKind === v.authKind,
  );
export const lifecycleAccountsV3 = z.strictObject({
  accounts: z.array(lifecycleAccountV3).max(100),
  nextCursor: reference.optional(),
});
const previous = lifecycleOperation.options;
export const lifecycleOperationV3 = z
  .discriminatedUnion("state", [
    previous[0].extend({ account: lifecycleAccountV3 }),
    previous[1].extend({
      result: z.strictObject({ kind: z.literal("account_lifecycle"), account: lifecycleAccountV3 }),
    }),
    previous[2].extend({ account: lifecycleAccountV3 }),
    previous[3].extend({ account: lifecycleAccountV3 }),
  ])
  .refine((v) => {
    const account = v.state === "applied" ? v.result.account : v.account;
    return (
      v.intent.accountRef === account.accountRef &&
      v.intent.profileId === account.profileId &&
      (v.state !== "applied" ||
        (account.metadataRevision === v.intent.expectedMetadataRevision + 1 &&
          account.state === (v.intent.action === "suspend" ? "suspended" : "active")))
    );
  });
export type LifecycleCapabilityV3 = z.infer<typeof lifecycleCapabilityV3>;
export type LifecycleAccountV3 = z.infer<typeof lifecycleAccountV3>;
export type LifecycleAccountsV3 = z.infer<typeof lifecycleAccountsV3>;
export type LifecycleOperationV3 = z.infer<typeof lifecycleOperationV3>;
