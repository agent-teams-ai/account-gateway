import type { FailureVerdict } from "./failure.js";
import type { LlmUsage } from "./outcome.js";
import type { LlmTask } from "./task.js";

/** Terminal provider report reduced from one response stream. */
export type Generation = {
  readonly status: "completed" | "incomplete" | "failed";
  readonly incompleteReason: string | null;
  readonly text: string;
  readonly refused: boolean;
  readonly usage: LlmUsage;
  readonly observedModel: string | null;
  readonly responseId: string | null;
};
/** interrupted: the stream ended without any terminal event. */
export type GenerationOutcome = Generation | { readonly status: "interrupted" };

const paid = { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true } as const;

/** The model is never trusted: JSON is parsed and the consumer decode always runs. */
export function settleGeneration<T>(
  generation: Generation,
  task: Pick<LlmTask<T>, "output" | "decode">,
): { readonly ok: true; readonly value: T } | ({ readonly ok: false } & FailureVerdict) {
  if (generation.status === "failed") {
    return { ok: false, code: "provider_failed", effect: "response_started", retry: paid };
  }
  if (generation.status === "incomplete") {
    return generation.incompleteReason === "content_filter"
      ? { ok: false, code: "output_refused", effect: "completed", retry: { kind: "never" } }
      : { ok: false, code: "output_truncated", effect: "completed", retry: paid };
  }
  if (generation.text.trim() === "") {
    return generation.refused
      ? { ok: false, code: "output_refused", effect: "completed", retry: { kind: "never" } }
      : { ok: false, code: "output_invalid", effect: "completed", retry: paid };
  }
  try {
    const parsed: unknown =
      task.output.mode === "text" ? generation.text : JSON.parse(generation.text);
    return { ok: true, value: task.decode ? task.decode(parsed) : (parsed as T) };
  } catch {
    return { ok: false, code: "output_invalid", effect: "completed", retry: paid };
  }
}
