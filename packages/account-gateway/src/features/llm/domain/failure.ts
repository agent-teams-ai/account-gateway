import type { LlmEffect, LlmFailure, LlmFailureCode, LlmRetry } from "./outcome.js";

export type FailureVerdict = Pick<LlmFailure, "code" | "effect" | "retry"> & {
  readonly traceRef?: string;
};

/**
 * Primitive projection of a gateway error. access is runAccess, before any
 * inference request of the attempt exists; inference is request, stream or status.
 */
export type GatewayFault = {
  readonly stage: "access" | "inference";
  readonly kind: "invalid_input" | "transport" | "invalid_response" | "cancelled" | "safe_error";
  readonly effect: LlmEffect;
  readonly code?:
    | "invalid_request"
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "admission_limited"
    | "upstream_failure"
    | "internal_error";
  readonly afterMs?: number;
  readonly traceRef?: string;
};

const never: LlmRetry = Object.freeze({ kind: "never" });
const ambiguous = (effect: LlmEffect): boolean =>
  effect === "effect_unknown" || effect === "dispatch_started" || effect === "response_started";
/** Whether the provider may have been invoked, so another attempt may cost again. */
export const mayHaveCost = (effect: LlmEffect): boolean =>
  effect !== "not_dispatched" && effect !== "rejected_before_dispatch";

function verdict(
  code: LlmFailureCode,
  effect: LlmEffect,
  retry: LlmRetry,
  traceRef: string | undefined,
): FailureVerdict {
  return traceRef === undefined ? { code, effect, retry } : { code, effect, retry, traceRef };
}

export function classifyFault(fault: GatewayFault): FailureVerdict {
  const afterMs = fault.afterMs ?? 0;
  const next = (mayDuplicateCost: boolean): LlmRetry => ({
    kind: "new_attempt",
    afterMs,
    mayDuplicateCost,
  });
  const v = (code: LlmFailureCode, effect: LlmEffect, retry: LlmRetry) =>
    verdict(code, effect, retry, fault.traceRef);
  if (fault.kind === "invalid_input") {
    return v("invalid_task", "not_dispatched", never);
  }
  if (fault.stage === "access") {
    // No inference exists yet. An ambiguous grant is recovered by an identical replay.
    if (fault.kind === "cancelled") {
      return v("cancelled", "not_dispatched", never);
    }
    const recover: LlmRetry = { kind: "same_attempt", afterMs };
    if (fault.kind !== "safe_error") {
      return v("unavailable", "not_dispatched", recover);
    }
    switch (fault.code) {
      case "invalid_request":
        return v("rejected", "not_dispatched", never);
      case "unauthenticated":
      case "forbidden":
        return v("unauthorized", "not_dispatched", never);
      case "conflict":
        // Another intent owns this attempt; it may already have run inference.
        return v("conflict", "not_dispatched", next(true));
      case "admission_limited":
        return v("busy", "not_dispatched", next(false));
      case "not_found":
      case "upstream_failure":
      case "internal_error":
      case undefined:
        return v("unavailable", "not_dispatched", ambiguous(fault.effect) ? recover : next(false));
    }
  }
  if (fault.kind === "cancelled") {
    return v("cancelled", fault.effect, never);
  }
  if (fault.kind !== "safe_error" || fault.effect === "effect_unknown") {
    return v("effect_unknown", "effect_unknown", next(true));
  }
  switch (fault.effect) {
    case "rejected_before_dispatch":
      return v("rejected", fault.effect, never);
    case "completed":
      return v("output_lost", fault.effect, next(true));
    case "dispatch_started":
    case "response_started":
      return v("provider_failed", fault.effect, next(true));
    case "not_dispatched":
      switch (fault.code) {
        case "invalid_request":
          return v("rejected", fault.effect, never);
        case "unauthenticated":
        case "forbidden":
          return v("unauthorized", fault.effect, never);
        case "admission_limited":
          return v("busy", fault.effect, next(false));
        case "conflict":
          return v("conflict", fault.effect, next(false));
        case "not_found":
        case "upstream_failure":
        case "internal_error":
        case undefined:
          return v("unavailable", fault.effect, next(false));
      }
  }
}

/** Readback of one inference request after a lost stream or a repeated request. */
export type RequestReadback = {
  readonly status: "pending" | "completed" | "cancelled" | "failed" | "unknown";
  readonly effect: LlmEffect;
  readonly error?: {
    readonly code: NonNullable<GatewayFault["code"]>;
    readonly traceRef: string;
    readonly retry:
      | { readonly kind: "never" }
      | { readonly kind: "readback" }
      | { readonly kind: "after"; readonly milliseconds: number };
  };
};

export function classifyReadback(readback: RequestReadback): FailureVerdict {
  const traceRef = readback.error?.traceRef;
  switch (readback.status) {
    case "completed":
      // Paid and finished, but the gateway never stores output.
      return verdict(
        "output_lost",
        "completed",
        { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
        traceRef,
      );
    case "pending":
    case "unknown":
      return verdict(
        "effect_unknown",
        "effect_unknown",
        { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
        traceRef,
      );
    case "failed":
    case "cancelled": {
      const retry = readback.error?.retry;
      return classifyFault({
        stage: "inference",
        kind: "safe_error",
        effect: readback.effect,
        ...(readback.error ? { code: readback.error.code, traceRef: readback.error.traceRef } : {}),
        ...(retry?.kind === "after" ? { afterMs: retry.milliseconds } : {}),
      });
    }
  }
}

/** Caller cancellation or the task deadline overrides the code, never the effect. */
export function interruptedVerdict(
  reason: "cancelled" | "deadline",
  observed: FailureVerdict,
): FailureVerdict {
  const retry: LlmRetry =
    reason === "cancelled"
      ? never
      : { kind: "new_attempt", afterMs: 0, mayDuplicateCost: mayHaveCost(observed.effect) };
  return verdict(reason, observed.effect, retry, observed.traceRef);
}
