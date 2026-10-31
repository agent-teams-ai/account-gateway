import type { ConsumerControlClient, ExecutionClient } from "../../facade-client/http/index.js";
import type { GenerationOutcome, LlmResult, LlmTask } from "../domain/index.js";

/** Wire protocol of one model call: exact request bytes and stream reduction. */
export interface ModelProtocol {
  encode(task: LlmTask): Uint8Array<ArrayBuffer>;
  decoder(): GenerationDecoder;
}
/** push throws on malformed provider bytes; finish never invents a terminal event. */
export interface GenerationDecoder {
  push(bytes: Uint8Array): void;
  finish(): GenerationOutcome;
}

/**
 * The facade capabilities themselves, so a fake and the HTTP client share one
 * contract, including GatewayError effects.
 */
export type ConsumerControlPort = Pick<ConsumerControlClient, "runAccess">;
export type ExecutionPort = Pick<ExecutionClient, "request" | "status" | "close">;

/** Execution-scoped access issued by runAccess for one attempt. */
export type ExecutionGrant = { readonly bearer: string; readonly timeoutMs: number };
export type ExecutionConnector = (grant: ExecutionGrant) => ExecutionPort;

export type LlmClientConfig = {
  readonly control: ConsumerControlPort;
  readonly connectExecution: ExecutionConnector;
  /** Bound for status readback and close, independent of the task signal. 1..60 000, default 10 000. */
  readonly controlTimeoutMs?: number;
  /** Clock for deadline admission; the deadline timer itself uses the runtime clock. */
  readonly now?: () => number;
};

export interface LlmClient {
  generate<T = unknown>(
    task: LlmTask<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LlmResult<T>>;
}
