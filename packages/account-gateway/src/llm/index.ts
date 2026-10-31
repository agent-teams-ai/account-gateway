/** Experimental 0.x entry: one bounded model call over facade execution capabilities. */
import { createExecutionClient } from "../features/facade-client/http/index.js";
import { openAIResponses } from "../features/llm/adapters/index.js";
import { createLlmGenerator } from "../features/llm/application/index.js";
import type {
  ExecutionConnector,
  LlmClient,
  LlmClientConfig,
} from "../features/llm/application/index.js";

export type {
  LlmCleanup,
  LlmEffect,
  LlmEffort,
  LlmExecution,
  LlmFailure,
  LlmFailureCode,
  LlmMessage,
  LlmOutput,
  LlmPolicy,
  LlmReceipt,
  LlmResult,
  LlmRetry,
  LlmSuccess,
  LlmTask,
  LlmUsage,
} from "../features/llm/domain/index.js";
export {
  LLM_DEFAULT_OUTPUT_BYTES,
  LLM_MAX_DEADLINE_MS,
  LLM_MAX_OUTPUT_BYTES,
  LLM_MAX_OUTPUT_TOKENS,
  LLM_MAX_REQUEST_BYTES,
} from "../features/llm/domain/index.js";
export type {
  ConsumerControlPort,
  ExecutionConnector,
  ExecutionGrant,
  ExecutionPort,
  LlmClient,
  LlmClientConfig,
} from "../features/llm/application/index.js";

export { LlmSchemaError, prepareStrictJsonSchema } from "../features/llm/adapters/index.js";
export type { StrictJsonSchema } from "../features/llm/adapters/index.js";

/** Facade execution origins for the HTTP connector; the bearer comes from runAccess. */
export type LlmExecutionOrigins = {
  readonly origin: string;
  readonly inferenceOrigin?: string;
};

export function createLlmClient(config: LlmClientConfig): LlmClient {
  return createLlmGenerator({ ...config, protocol: openAIResponses });
}

/** HTTP execution client per grant. Origins are validated here, before any grant exists. */
export function executionConnector(origins: LlmExecutionOrigins): ExecutionConnector {
  const settings = {
    role: "execution",
    origin: origins.origin,
    ...(origins.inferenceOrigin === undefined ? {} : { inferenceOrigin: origins.inferenceOrigin }),
    // Provider chunks larger than the 64 KiB default are valid stream bytes.
    bufferBytes: 1_048_576,
  } as const;
  createExecutionClient({ ...settings, token: "origin-validation" });
  return (grant) =>
    createExecutionClient({ ...settings, token: grant.bearer, timeoutMs: grant.timeoutMs });
}
