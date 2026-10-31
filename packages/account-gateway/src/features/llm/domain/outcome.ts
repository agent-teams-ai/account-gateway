/** Null means the provider stream did not report the value. */
export type LlmUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
};

/** Gateway identities of one attempt; usable for usage readback by the consumer. */
export type LlmExecution = {
  readonly executionRef: string;
  readonly requestRef: string;
  readonly accountRef: string;
  readonly authorizationEpoch: number;
};

export type LlmReceipt = LlmExecution & {
  readonly taskId: string;
  readonly attempt: number;
  readonly profileId: string;
  /** Requested model. */
  readonly model: string;
  /** Model reported by the provider stream, if any. */
  readonly observedModel: string | null;
  readonly responseId: string | null;
  /** Hex SHA-256 of the exact request body bytes. */
  readonly requestSha256: string;
  /** Hex SHA-256 of the UTF-8 output text. */
  readonly outputSha256: string;
};

/** Provider effect of the inference request, in the gateway vocabulary. */
export type LlmEffect =
  | "not_dispatched"
  | "rejected_before_dispatch"
  | "dispatch_started"
  | "response_started"
  | "completed"
  | "effect_unknown";

export type LlmFailureCode =
  | "invalid_task"
  | "rejected"
  | "unauthorized"
  | "busy"
  | "unavailable"
  | "conflict"
  | "provider_failed"
  | "output_truncated"
  | "output_refused"
  | "output_invalid"
  | "output_lost"
  | "effect_unknown"
  | "cancelled"
  | "deadline";

/**
 * Advice only. The library never retries. same_attempt replays the identical task
 * to recover an ambiguous execution grant before any inference was dispatched.
 * new_attempt uses attempt + 1; mayDuplicateCost means the previous attempt may
 * already have been paid. afterMs is the gateway minimum delay, or 0.
 */
export type LlmRetry =
  | { readonly kind: "never" }
  | { readonly kind: "same_attempt"; readonly afterMs: number }
  | { readonly kind: "new_attempt"; readonly afterMs: number; readonly mayDuplicateCost: boolean };

/** closed: the execution was closed; pending: close was not acknowledged; not_needed: no execution. */
export type LlmCleanup = "closed" | "pending" | "not_needed";

export type LlmSuccess<T> = {
  readonly ok: true;
  /** Decoded value, the parsed JSON value, or the text in text mode. */
  readonly value: T;
  readonly text: string;
  readonly usage: LlmUsage;
  readonly receipt: LlmReceipt;
  readonly cleanup: "closed" | "pending";
};

export type LlmFailure = {
  readonly ok: false;
  readonly code: LlmFailureCode;
  readonly effect: LlmEffect;
  readonly retry: LlmRetry;
  /** Gateway safe trace reference only; never prompts, outputs or credentials. */
  readonly traceRef?: string;
  readonly execution: LlmExecution | null;
  readonly usage: LlmUsage | null;
  readonly cleanup: LlmCleanup;
};

export type LlmResult<T> = LlmSuccess<T> | LlmFailure;
