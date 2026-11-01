import * as c from "@agent-teams/account-gateway/contracts";
import { isDeepStrictEqual } from "node:util";
import { KernelError } from "./domain.ts";

export type AccountLimitsSelector = c.AccountLimitsRequest;
export type AccountLimitsWireSource =
  | {
      readonly contract: "account-limits/v1";
      read(input: AccountLimitsSelector): Promise<c.AccountLimits>;
    }
  | {
      readonly contract: "account-limits/v2";
      read(input: AccountLimitsSelector): Promise<c.AccountLimitsV2>;
    };
export interface AccountLimitsAuthority {
  authorize(input: AccountLimitsSelector): Promise<boolean>;
  currentIdentity(input: AccountLimitsSelector): Promise<unknown>;
}
export type AccountLimitsPortResult = {
  readonly wire: c.AccountLimits | c.AccountLimitsV2;
};
const empty = (): AccountLimitsPortResult => ({ wire: { status: "unsupported" } });
type LimitsProvider = c.ProviderConnectionCapability["provider"]["identity"];
/** Versioned wire validation plus provider identity; anything else is unavailable. */
export function acceptedLimitsWire(
  contract: AccountLimitsWireSource["contract"],
  observed: unknown,
  provider?: LimitsProvider,
): c.AccountLimits | c.AccountLimitsV2 {
  const parsed = (contract === "account-limits/v2" ? c.accountLimitsV2 : c.accountLimits).safeParse(
    observed,
  );
  if (!parsed.success) {
    return { status: "unavailable" };
  }
  const result = parsed.data;
  if (result.status === "snapshot" && provider) {
    const matches =
      contract === "account-limits/v2"
        ? (result as Extract<c.AccountLimitsV2, { status: "snapshot" }>).windows.every(
            (window) => window.provider === provider,
          )
        : (result as Extract<c.AccountLimits, { status: "snapshot" }>).windows.every(
            (window) =>
              window.family ===
              (provider === "openai" ? "codex" : provider === "anthropic" ? "claude" : undefined),
          );
    if (!matches) {
      return { status: "unavailable" };
    }
  }
  return result;
}
/**
 * The sole cached consumer-facing limits port. It owns authorization, both
 * generation/identity fences and versioned wire validation.
 */
export async function readCachedAccountLimits(
  authority: AccountLimitsAuthority,
  source: AccountLimitsWireSource | undefined,
  input: AccountLimitsSelector,
  expected: {
    readonly contract: "account-limits/v1" | "account-limits/v2";
    readonly provider?: LimitsProvider;
  },
): Promise<AccountLimitsPortResult> {
  if (!(await authority.authorize(input))) {
    throw new KernelError("denied");
  }
  if (!source || source.contract !== expected.contract) {
    return empty();
  }
  const before = await authority.currentIdentity(input);
  let result: c.AccountLimits | c.AccountLimitsV2 = { status: "unavailable" };
  try {
    result = acceptedLimitsWire(source.contract, await source.read(input), expected.provider);
  } catch {
    /* Preserve the safe union; still revalidate after the await. */
  }
  const after = await authority.currentIdentity(input);
  if (!isDeepStrictEqual(before, after) || !(await authority.authorize(input))) {
    throw new KernelError("denied");
  }
  return { wire: result };
}
