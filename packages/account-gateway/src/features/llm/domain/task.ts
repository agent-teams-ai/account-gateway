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
