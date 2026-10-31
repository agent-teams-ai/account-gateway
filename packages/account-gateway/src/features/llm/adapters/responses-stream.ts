import type { GenerationDecoder } from "../application/index.js";
import type { Generation, GenerationOutcome, LlmUsage } from "../domain/index.js";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, 256) : null;

/** Same bounded interpretation as gateway usage capture; malformed counts stay null. */
function usageOf(response: Json): LlmUsage {
  const usage = record(response.usage) ? response.usage : {};
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cached = record(usage.input_tokens_details)
    ? count(usage.input_tokens_details.cached_tokens)
    : null;
  const reasoning = record(usage.output_tokens_details)
    ? count(usage.output_tokens_details.reasoning_tokens)
    : null;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached !== null && input !== null && cached <= input ? cached : null,
    reasoningTokens:
      reasoning !== null && output !== null && reasoning <= output ? reasoning : null,
  };
}

/** Text and refusal parts of message items in a final response snapshot. */
function snapshotOf(response: Json): { text: string | null; refused: boolean } {
  let text: string | null = null;
  let refused = false;
  for (const item of Array.isArray(response.output) ? (response.output as unknown[]) : []) {
    if (!record(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content as unknown[]) {
      if (record(part) && part.type === "output_text" && typeof part.text === "string") {
        text = (text ?? "") + part.text;
      } else if (record(part) && part.type === "refusal") {
        refused = true;
      }
    }
  }
  return { text, refused };
}

/**
 * Server-sent events per the WHATWG grammar (LF, CR or CRLF; multi-line data;
 * comments), reduced to the first terminal Responses event. Non-terminal events
 * are informational; malformed event JSON throws.
 */
export function createResponsesDecoder(): GenerationDecoder {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let afterCR = false;
  let data: string[] = [];
  let deltas = "";
  const done: string[] = [];
  let refused = false;
  let terminal: Generation | undefined;

  function apply(event: Json): void {
    if (terminal) {
      return;
    }
    switch (event.type) {
      case "response.output_text.delta":
        deltas += typeof event.delta === "string" ? event.delta : "";
        return;
      case "response.output_text.done":
        if (typeof event.text === "string") {
          done.push(event.text);
        }
        return;
      case "response.refusal.delta":
      case "response.refusal.done":
        refused = true;
        return;
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = record(event.response) ? event.response : {};
        const snapshot = snapshotOf(response);
        const details = record(response.incomplete_details) ? response.incomplete_details : {};
        terminal = {
          status:
            event.type === "response.completed"
              ? "completed"
              : event.type === "response.incomplete"
                ? "incomplete"
                : "failed",
          incompleteReason: label(details.reason),
          // A final snapshot is authoritative; done texts and deltas are fallbacks.
          text: snapshot.text ?? (done.length > 0 ? done.join("") : deltas),
          refused: refused || snapshot.refused,
          usage: usageOf(response),
          observedModel: label(response.model),
          responseId: label(response.id),
        };
        return;
      }
      case "error":
        terminal = {
          status: "failed",
          incompleteReason: null,
          text: "",
          refused,
          usage: usageOf({}),
          observedModel: null,
          responseId: null,
        };
        return;
      default:
        return;
    }
  }

  function dispatch(): void {
    if (data.length === 0) {
      return;
    }
    const payload = data.join("\n");
    data = [];
    if (payload === "[DONE]") {
      return;
    }
    const event: unknown = JSON.parse(payload);
    if (!record(event)) {
      throw new TypeError("Malformed Responses event.");
    }
    apply(event);
  }

  function line(value: string): void {
    if (value === "") {
      dispatch();
    } else if (value.startsWith("data:")) {
      data.push(value.startsWith("data: ") ? value.slice(6) : value.slice(5));
    } else if (value === "data") {
      data.push("");
    }
    // event, id, retry, comments and unknown fields carry no Responses meaning.
  }

  function scan(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 10 && afterCR) {
        afterCR = false;
        start = index + 1;
        continue;
      }
      afterCR = code === 13;
      if (code === 10 || code === 13) {
        line(text.slice(start, index));
        start = index + 1;
      }
    }
    pending = text.slice(start);
  }

  return {
    push(bytes) {
      scan(pending + utf8.decode(bytes, { stream: true }));
    },
    finish(): GenerationOutcome {
      scan(pending + utf8.decode());
      // A final event without its blank line is still dispatched.
      line(pending);
      line("");
      pending = "";
      return terminal ?? { status: "interrupted" };
    },
  };
}
