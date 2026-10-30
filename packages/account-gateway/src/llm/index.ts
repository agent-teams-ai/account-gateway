/** Experimental 0.x entry: one bounded model call over facade execution capabilities. */
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
export type {
  ConsumerControlPort,
  ExecutionConnector,
  ExecutionGrant,
  ExecutionPort,
  LlmClient,
  LlmClientConfig,
} from "../features/llm/application/index.js";

/** Facade execution origins for the HTTP connector; the bearer comes from runAccess. */
export type LlmExecutionOrigins = {
  readonly origin: string;
  readonly inferenceOrigin?: string;
};
