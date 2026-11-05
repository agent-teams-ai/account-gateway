import { randomUUID } from "node:crypto";
import * as c from "@agent-teams/account-gateway/contracts";
import type { SavedExecution, RequestStatus } from "./domain.ts";
import type { AccountManagement, AccountLifecycleReadback } from "./management.ts";

// Bounded wire projections: no socket, SQL, native transport or credential access.
export function safe(
  code: c.SafeError["code"],
  effect: c.SafeError["effect"] = "effect_unknown",
  identity: { operationRef?: string; requestRef?: string } = {},
): c.SafeError {
  return c.safeError.parse({
    code,
    traceRef: randomUUID(),
    ...identity,
    effect,
    retry: { kind: effect === "effect_unknown" ? "readback" : "never" },
  });
}
export function requestDTO(r: RequestStatus): c.RequestStatus {
  const status =
    r.effect === "completed"
      ? "completed"
      : r.effect === "effect_unknown"
        ? "unknown"
        : ["not_dispatched", "rejected_before_dispatch"].includes(r.effect)
          ? "failed"
          : "pending";
  const concurrencyLimited = r.code === "concurrency_limit" && r.effect === "not_dispatched";
  const error =
    status === "failed" || status === "unknown"
      ? {
          ...safe(
            r.code === "limit" || r.code === "concurrency_limit"
              ? "admission_limited"
              : "upstream_failure",
            r.effect,
            { requestRef: r.requestRef },
          ),
          ...(concurrencyLimited ? { retry: { kind: "after", milliseconds: 1000 } } : {}),
        }
      : undefined;
  return c.requestStatus.parse({
    requestRef: r.requestRef,
    effect: r.effect,
    status,
    ...(error ? { error } : {}),
  });
}
export function accountDTO(a: Awaited<ReturnType<AccountManagement["account"]>>): c.Account {
  return c.account.parse({
    accountRef: a.accountRef,
    ownerRef: a.ownerRef,
    profileId: a.profile,
    displayName: a.displayName,
    state: a.state,
    metadataRevision: a.revision,
    authorizationEpoch: a.epoch,
  });
}
export function lifecycleAccountDTO(r: AccountLifecycleReadback): c.LifecycleAccount {
  const a = r.account;
  return c.lifecycleAccount.parse({
    accountRef: a.accountRef,
    ownerRef: a.ownerRef,
    profileId: a.profile,
    displayName: a.displayName,
    state: a.state,
    metadataRevision: a.revision,
    authorizationEpoch: a.epoch,
    authKind: r.authKind,
    resumeCustody: r.resumeCustody,
  });
}
export function retirementDTO(
  r: Awaited<ReturnType<AccountManagement["retirement"]>>,
): c.AccountRetirement {
  return c.accountRetirement.parse({
    operationRef: r.operationRef,
    account: accountDTO(r.account),
    state: r.state,
    fence: r.fence,
    counts: r.counts,
    inert: r.inert,
  });
}
export const executionState = (state: SavedExecution["state"]): c.Execution["state"] =>
  state === "open" ? "active" : state === "closed" ? "terminal" : "fenced";
