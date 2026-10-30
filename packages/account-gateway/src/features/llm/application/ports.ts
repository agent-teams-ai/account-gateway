import type { ConsumerControlClient, ExecutionClient } from "../../facade-client/http/index.js";
import type { LlmResult, LlmTask } from "../domain/index.js";

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
  /** Bound for status readback and close, independent of the task signal. Default 10 000. */
  readonly controlTimeoutMs?: number;
  readonly now?: () => number;
};

export interface LlmClient {
  generate<T = unknown>(
    task: LlmTask<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LlmResult<T>>;
}
