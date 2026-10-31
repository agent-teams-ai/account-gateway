/** Explicit reasoning effort. The gateway admits only values qualified for the selected model. */
export type LlmEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type LlmMessage = {
  readonly role: "user" | "assistant" | "system" | "developer";
  readonly text: string;
};

/**
 * Structured output is selected by the caller. The name of a json_schema format is
 * fixed by the native provider boundary; the schema itself is sent unchanged.
 */
export type LlmOutput =
  | {
      readonly mode: "json_schema";
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
    }
  | { readonly mode: "json_object" }
  | { readonly mode: "text" };

/** Consumer policy tuple bound into the execution intent. */
export type LlmPolicy = {
  readonly subjectRef: string;
  readonly policyRevision: number;
  readonly bindingRevision: number;
};

export type LlmTask<T = unknown> = {
  /** Stable consumer key of one logical task. With attempt it derives every gateway identity. */
  readonly taskId: string;
  /** 1-based. A new attempt is a new execution and may be paid again. */
  readonly attempt: number;
  readonly profileId: string;
  readonly model: string;
  /** Consumer preference order. The gateway selects the first active account. */
  readonly accountRefs: readonly string[];
  readonly policy: LlmPolicy;
  readonly instructions: string;
  readonly input: string | readonly LlmMessage[];
  readonly output: LlmOutput;
  /** Sent only when present; otherwise the provider default applies. */
  readonly effort?: LlmEffort;
  readonly maxOutputTokens: number;
  /** Absolute and at most one hour ahead. It is part of the execution intent. */
  readonly deadline: Date;
  readonly limits?: { readonly outputBytes?: number };
  /**
   * Optional validation of the parsed JSON value, or of the text in text mode.
   * A thrown error yields output_invalid; its message is not retained.
   */
  readonly decode?: (value: unknown) => T;
};

/**
 * Gateway kernel acceptance ceilings for one execution profile. Native admits
 * larger bodies, but a facade profile above these bounds is never configured.
 */
export const LLM_MAX_REQUEST_BYTES = 1_048_576;
export const LLM_MAX_OUTPUT_BYTES = 8_388_608;
export const LLM_MAX_OUTPUT_TOKENS = 100_000;
export const LLM_DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Run-access maxRunMs ceiling. */
export const LLM_MAX_DEADLINE_MS = 3_600_000;

const taskId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const roles = new Set(["user", "assistant", "system", "developer"]);
const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
const integer = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function admissibleOutput(output: unknown): boolean {
  if (!record(output)) {
    return false;
  }
  switch (output.mode) {
    case "json_schema":
      return (
        record(output.schema) && (output.strict === undefined || typeof output.strict === "boolean")
      );
    case "json_object":
    case "text":
      return true;
    default:
      return false;
  }
}

/**
 * Local shape checks only. Reference grammar, account ownership and limit ceilings
 * remain gateway authority. Time enters explicitly.
 */
export function admissibleTask(task: LlmTask, now: number): boolean {
  const t: unknown = task;
  if (!record(t) || !record(t.policy) || !(t.deadline instanceof Date)) {
    return false;
  }
  const remaining = t.deadline.getTime() - now;
  const input = typeof t.input === "string" ? [{ role: "user", text: t.input }] : t.input;
  const limits: unknown = t.limits ?? {};
  return (
    typeof t.taskId === "string" &&
    taskId.test(t.taskId) &&
    integer(t.attempt, 1, 9999) &&
    text(t.profileId) &&
    text(t.model) &&
    Array.isArray(t.accountRefs) &&
    t.accountRefs.length > 0 &&
    text(t.instructions) &&
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((m: unknown) => record(m) && roles.has(m.role as string) && text(m.text)) &&
    admissibleOutput(t.output) &&
    (t.effort === undefined || efforts.has(t.effort as string)) &&
    integer(t.maxOutputTokens, 1, LLM_MAX_OUTPUT_TOKENS) &&
    remaining > 0 &&
    remaining <= LLM_MAX_DEADLINE_MS &&
    record(limits) &&
    (limits.outputBytes === undefined || integer(limits.outputBytes, 1, LLM_MAX_OUTPUT_BYTES)) &&
    (t.decode === undefined || typeof t.decode === "function")
  );
}

/** Every gateway identity of one attempt; parsing from the right is unambiguous. */
export function taskIdentity(task: Pick<LlmTask, "taskId" | "attempt">) {
  const prefix = `${task.taskId}-a${String(task.attempt)}`;
  return {
    invocationRef: task.taskId,
    attemptRef: `a${String(task.attempt)}`,
    prepareId: `${prefix}-p`,
    requestId: `${prefix}-r`,
    closeId: `${prefix}-c`,
  } as const;
}
