import type { LlmOutput, LlmTask } from "../domain/index.js";

function textFormat(output: LlmOutput) {
  switch (output.mode) {
    case "json_schema":
      // Native coding-plan and Grok admission accept only this fixed format name.
      return {
        text: {
          format: {
            type: "json_schema",
            name: "codex_output_schema",
            strict: output.strict ?? true,
            schema: output.schema,
          },
        },
      };
    case "json_object":
      return { text: { format: { type: "json_object" } } };
    case "text":
      return {};
  }
}

/**
 * One OpenAI Responses body for every profile. Native admission requires stream,
 * store false, the default tier and max_output_tokens, and strips what a provider
 * rejects. reasoning appears only for an explicit effort.
 */
export function encodeResponsesRequest(task: LlmTask): Uint8Array<ArrayBuffer> {
  const messages =
    typeof task.input === "string" ? [{ role: "user" as const, text: task.input }] : task.input;
  return new TextEncoder().encode(
    JSON.stringify({
      model: task.model,
      instructions: task.instructions,
      input: messages.map((message) => ({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.text,
          },
        ],
      })),
      stream: true,
      store: false,
      service_tier: "default",
      max_output_tokens: task.maxOutputTokens,
      ...(task.effort === undefined ? {} : { reasoning: { effort: task.effort } }),
      ...textFormat(task.output),
    }),
  );
}
