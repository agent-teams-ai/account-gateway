import { z } from "zod";
import * as c from "../contracts/index.js";

import { connect, reconnect, nativeRequest, oauthComplete } from "./ingress.js";
import type { OAuthComplete } from "./ingress.js";
export * as secretSubmission from "./ingress.js";
const config = z.strictObject({
  role: z.enum(["management", "execution", "consumer-control"]),
  origin: z.string().check(z.url()),
  inferenceOrigin: z.string().check(z.url()).optional(),
  token: z.string().min(1).max(16384),
  responseBytes: z.number().int().min(1024).max(2097152).default(65536),
  timeoutMs: z.number().int().min(1).max(3600000).default(30000),
  bufferBytes: z.number().int().min(1024).max(1048576).default(65536),
});
export type ManagementConfig = z.input<typeof config> & { role: "management" };
export type ConsumerControlConfig = z.input<typeof config> & { role: "consumer-control" };
export type ExecutionConfig = z.input<typeof config> & { role: "execution" };
const lifecycleConfig = config.extend({
  role: z.enum(["management", "consumer-control"]),
  capability: z.literal(c.LIFECYCLE_CAPABILITY_CONTRACT),
  clientContract: z.literal(c.LIFECYCLE_CLIENT_CONTRACT),
});
export type LifecycleConfig = z.input<typeof lifecycleConfig>;
export type Connect = z.infer<typeof connect>;
export type Reconnect = z.infer<typeof reconnect>;
export interface CallOptions {
  signal?: AbortSignal;
}
export class GatewayError extends Error {
  constructor(
    readonly code: "invalid_input" | "transport" | "invalid_response" | "cancelled" | "safe_error",
    readonly effect: z.infer<typeof c.effectState>,
    readonly operationRef?: string,
    readonly requestRef?: string,
    readonly diagnostic?: c.SafeError,
    readonly httpStatus?: number,
  ) {
    super(`Account gateway: ${code}`);
    this.name = "GatewayError";
  }
}
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }
  return result.data;
}
const id = (value: string) => encodeURIComponent(valid(c.reference, value));
export const operationPath = (operationId: string) => `/v1/operations/${id(operationId)}`;
export const requestPath = (executionRef: string, requestId: string) =>
  `/v1/executions/${id(executionRef)}/requests/${id(requestId)}`;

type Identity = { operationRef?: string; requestRef?: string };
async function bounded(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) {
    throw new Error("Gateway response body is absent.");
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maximum) {
        throw new Error("Gateway response exceeds its byte limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function transport(
  input: ManagementConfig | ExecutionConfig | ConsumerControlConfig,
  role: "management" | "execution" | "consumer-control",
) {
  const versions: { readonly node?: unknown } | null | undefined =
    typeof process === "undefined" ? undefined : process.versions;
  const nodeAvailable = Boolean(versions?.node);
  if (!nodeAvailable) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }
  const settings = valid(config, input);
  if (settings.role !== role) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }
  const origin = new URL(settings.origin);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)
      ))
  ) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }
  const inferenceOrigin =
    settings.inferenceOrigin === undefined ? origin : new URL(settings.inferenceOrigin);
  if (
    (settings.inferenceOrigin !== undefined && role !== "execution") ||
    inferenceOrigin.username ||
    inferenceOrigin.password ||
    inferenceOrigin.search ||
    inferenceOrigin.hash ||
    inferenceOrigin.pathname !== "/" ||
    (inferenceOrigin.protocol !== "https:" &&
      !(
        inferenceOrigin.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(inferenceOrigin.hostname)
      ))
  ) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }
  async function enter(
    path: string,
    method: string,
    body: string | Uint8Array | undefined,
    headers: Record<string, string>,
    options: CallOptions,
    identity: Identity,
    targetOrigin = origin,
  ) {
    if (options.signal?.aborted === true) {
      throw new GatewayError(
        "cancelled",
        "not_dispatched",
        identity.operationRef,
        identity.requestRef,
      );
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const dispose = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const failure = (code: "transport" | "invalid_response" | "cancelled") =>
      new GatewayError(code, "effect_unknown", identity.operationRef, identity.requestRef);
    try {
      const response = await fetch(new URL(path, targetOrigin), {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: { authorization: `Bearer ${settings.token}`, ...headers },
        body: body as BodyInit | undefined,
      });
      return { response, controller, dispose, failure };
    } catch {
      dispose();
      throw failure(controller.signal.aborted ? "cancelled" : "transport");
    }
  }
  async function json<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    bodyInput?: unknown,
    options: CallOptions = {},
    identity: Identity = {},
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const handle = await enter(
      path,
      method,
      bodyInput === undefined ? undefined : JSON.stringify(bodyInput),
      { "content-type": "application/json", accept: "application/json", ...extraHeaders },
      options,
      identity,
    );
    try {
      const { response } = handle;
      if (
        (response.status >= 300 && response.status < 400) ||
        response.headers.get("content-type")?.split(";")[0] !== "application/json"
      ) {
        throw handle.failure("invalid_response");
      }
      const parsed = await bounded(response, settings.responseBytes);
      if (!response.ok) {
        const error = c.safeError.safeParse(parsed);
        if (
          !error.success ||
          (identity.operationRef !== undefined &&
            identity.operationRef !== "" &&
            error.data.operationRef !== undefined &&
            error.data.operationRef !== "" &&
            error.data.operationRef !== identity.operationRef) ||
          (identity.requestRef !== undefined &&
            identity.requestRef !== "" &&
            error.data.requestRef !== undefined &&
            error.data.requestRef !== "" &&
            error.data.requestRef !== identity.requestRef)
        ) {
          throw handle.failure("invalid_response");
        }
        // A missing readback record cannot establish absence of a prior effect.
        const readbackMissing =
          response.status === 404 &&
          (path.startsWith("/v1/operations/") ||
            path.startsWith("/v2/operations/") ||
            path.includes("/requests/") ||
            (method === "GET" &&
              (/^\/v1\/accounts\/[A-Za-z0-9_-]+\/retirement\/[A-Za-z0-9_-]+$/.test(path) ||
                /^\/v1\/policy-fences\/[A-Za-z0-9_-]+\/closure$/.test(path))));
        const diagnostic: c.SafeError = readbackMissing
          ? { ...error.data, effect: "effect_unknown", retry: { kind: "readback" } }
          : error.data;
        throw new GatewayError(
          "safe_error",
          diagnostic.effect,
          identity.operationRef,
          identity.requestRef,
          diagnostic,
          response.status,
        );
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw handle.failure("invalid_response");
      }
      const operation =
        "operation" in (result.data as object)
          ? (result.data as c.OAuthBeginResponse).operation
          : (result.data as c.Operation);
      if (
        identity.operationRef !== undefined &&
        identity.operationRef !== "" &&
        "operationRef" in operation &&
        operation.operationRef !== identity.operationRef
      ) {
        throw handle.failure("invalid_response");
      }
      if (
        identity.requestRef !== undefined &&
        identity.requestRef !== "" &&
        "requestRef" in (result.data as object) &&
        (result.data as c.RequestStatus).requestRef !== identity.requestRef
      ) {
        throw handle.failure("invalid_response");
      }
      if (response.status === 202 && "state" in operation && operation.state !== "pending") {
        throw handle.failure("invalid_response");
      }
      return result.data;
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : handle.failure(handle.controller.signal.aborted ? "cancelled" : "invalid_response");
      handle.controller.abort();
      throw failure;
    } finally {
      handle.dispose();
    }
  }
  async function stream(
    executionRef: string,
    raw: NativeRequest,
    options: CallOptions = {},
  ): Promise<NativeResponse> {
    const request = valid(nativeRequest, raw);
    const identity = { requestRef: request.requestId };
    const handle = await enter(
      `/v1/executions/${id(executionRef)}/requests`,
      "POST",
      new Uint8Array(request.body),
      {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-gateway-request-id": request.requestId,
        "x-gateway-admission": JSON.stringify(request.admission),
      },
      options,
      identity,
      inferenceOrigin,
    );
    try {
      if (
        handle.response.status === 202 &&
        handle.response.headers.get("content-type")?.split(";")[0] === "application/json"
      ) {
        const status = c.requestStatus.safeParse(
          await bounded(handle.response, settings.responseBytes),
        );
        if (!status.success || status.data.requestRef !== request.requestId) {
          throw handle.failure("invalid_response");
        }
        handle.dispose();
        return { kind: "status", status: status.data };
      }
      if (!handle.response.ok) {
        const result = c.safeError.safeParse(
          await bounded(handle.response, settings.responseBytes),
        );
        if (
          !result.success ||
          (result.data.requestRef !== undefined &&
            result.data.requestRef !== "" &&
            result.data.requestRef !== request.requestId)
        ) {
          throw handle.failure("invalid_response");
        }
        throw new GatewayError(
          "safe_error",
          result.data.effect,
          undefined,
          request.requestId,
          result.data,
          handle.response.status,
        );
      }
      if (
        handle.response.status !== 200 ||
        handle.response.headers.get("x-gateway-request-ref") !== request.requestId ||
        handle.response.headers.get("content-type")?.split(";")[0] !== "text/event-stream" ||
        !handle.response.body
      ) {
        throw handle.failure("invalid_response");
      }
      const reader = handle.response.body.getReader();
      let size = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                handle.dispose();
                controller.close();
                return;
              }
              size += value.byteLength;
              if (
                value.byteLength > settings.bufferBytes ||
                size > request.admission.limits.outputBytes
              ) {
                throw handle.failure("invalid_response");
              }
              controller.enqueue(value);
            } catch (error) {
              const failure =
                error instanceof GatewayError
                  ? error
                  : handle.failure(handle.controller.signal.aborted ? "cancelled" : "transport");
              handle.controller.abort();
              handle.dispose();
              await reader.cancel().catch(() => {});
              controller.error(failure);
            }
          },
          async cancel() {
            handle.controller.abort();
            handle.dispose();
            await reader.cancel().catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      return {
        kind: "stream",
        requestRef: request.requestId,
        body,
        cancel: async () => {
          handle.controller.abort();
          handle.dispose();
          await reader.cancel().catch(() => {});
        },
      };
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : handle.failure(handle.controller.signal.aborted ? "cancelled" : "invalid_response");
      handle.controller.abort();
      handle.dispose();
      throw failure;
    }
  }
  return { json, stream };
}
export type NativeResponse =
  | {
      kind: "stream";
      requestRef: string;
      body: ReadableStream<Uint8Array>;
      cancel(): Promise<void>;
    }
  | { kind: "status"; status: c.RequestStatus };
export type NativeRequest = z.infer<typeof nativeRequest>;
function accountClient(
  settings: ManagementConfig | ConsumerControlConfig,
  role: "management" | "consumer-control",
) {
  const { json } = transport(settings, role);
  const mutate = (
    path: string,
    method: string,
    input: { operationId: string },
    options?: CallOptions,
    schema = c.accountOperation,
  ) => json(path, schema, method, input, options, { operationRef: input.operationId });
  return {
    json,
    client: Object.freeze({
      readAccountModels: (
        input: c.AccountModelsRequest,
        options?: CallOptions,
      ): Promise<c.AccountModels> =>
        json(
          "/v1/account-models/read",
          c.accountModels,
          "POST",
          valid(c.accountModelsRequest, input),
          options,
        ),
      getProviderConnectionCapabilities: (
        options?: CallOptions,
      ): Promise<c.ProviderConnectionCapabilities> =>
        json(
          "/v1/provider-connection-capabilities",
          c.providerConnectionCapabilities,
          "GET",
          undefined,
          options,
        ),
      profiles: (options?: CallOptions) =>
        json("/v1/profiles", c.profiles, "GET", undefined, options),
      list: (input: c.ListQuery = {}, options?: CallOptions) => {
        const entries: [string, c.ListQuery[keyof c.ListQuery]][] = Object.entries(
          valid(c.listQuery, input),
        );
        const query = new URLSearchParams(
          entries
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        );
        return json(
          query.size ? `/v1/accounts?${query}` : "/v1/accounts",
          c.accounts,
          "GET",
          undefined,
          options,
        );
      },
      get: (accountRef: string, options?: CallOptions) =>
        json(`/v1/accounts/${id(accountRef)}`, c.account, "GET", undefined, options),
      connect: (input: Connect, options?: CallOptions) =>
        mutate("/v1/accounts", "POST", valid(connect, input), options),
      // One call, no automatic retry or readback. A lost Begin URL is not rebuilt.
      beginOAuth: (input: c.OAuthBegin, options?: CallOptions): Promise<c.OAuthBeginResponse> => {
        const captured = valid(c.oauthBegin, input);
        return json("/v1/accounts/oauth/begin", c.oauthBeginResponse, "POST", captured, options, {
          operationRef: captured.operationId,
        });
      },
      // One fresh sensitive POST; duplicate/readback cannot rebuild a Begin URL.
      beginOAuthReconnect: (
        accountRef: string,
        input: c.OAuthReconnect,
        options?: CallOptions,
      ): Promise<c.OAuthBeginResponse> => {
        const captured = valid(c.oauthReconnect, input);
        return json(
          `/v1/accounts/${id(accountRef)}/reconnect`,
          c.oauthBeginResponse,
          "POST",
          captured,
          options,
          { operationRef: captured.operationId },
        );
      },
      // Sensitive POST only. Lost completion ACKs require ordinary readback.
      completeOAuth: (input: OAuthComplete, options?: CallOptions): Promise<c.Operation> => {
        const captured = valid(oauthComplete, input);
        return json("/v1/accounts/oauth/complete", c.accountOperation, "POST", captured, options, {
          operationRef: captured.operationId,
        });
      },
      // Explicit mutation. Native owns provider polling, throttling and exchange.
      pollDeviceOAuth: (input: c.OAuthPoll, options?: CallOptions): Promise<c.Operation> => {
        const captured = valid(c.oauthPoll, input);
        return json("/v1/accounts/oauth/poll", c.accountOperation, "POST", captured, options, {
          operationRef: captured.operationId,
        });
      },
      readOAuth: (operationId: string, options?: CallOptions): Promise<c.Operation> =>
        json(operationPath(operationId), c.accountOperation, "GET", undefined, options, {
          operationRef: operationId,
        }),
      rename: (accountRef: string, input: c.Rename, options?: CallOptions) =>
        mutate(`/v1/accounts/${id(accountRef)}`, "PATCH", valid(c.rename, input), options),
      reconnect: (accountRef: string, input: Reconnect, options?: CallOptions) =>
        mutate(
          `/v1/accounts/${id(accountRef)}/reconnect`,
          "POST",
          valid(reconnect, input),
          options,
        ),
      disable: (accountRef: string, input: c.Disable, options?: CallOptions) =>
        mutate(`/v1/accounts/${id(accountRef)}/disable`, "POST", valid(c.disable, input), options),
      retirement: async (
        accountRef: string,
        operationId: string,
        options?: CallOptions,
      ): Promise<c.AccountRetirement> => {
        const account = id(accountRef),
          operation = id(operationId);
        const result = await json(
          `/v1/accounts/${account}/retirement/${operation}`,
          c.accountRetirement,
          "GET",
          undefined,
          options,
          { operationRef: operationId },
        );
        if (result.account.accountRef !== accountRef || result.operationRef !== operationId) {
          throw new GatewayError("invalid_response", "effect_unknown", operationId);
        }
        return result;
      },
      policyClosure: (operationId: string, options?: CallOptions): Promise<c.PolicyUseClosure> =>
        json(
          `/v1/policy-fences/${id(operationId)}/closure`,
          c.policyUseClosure,
          "GET",
          undefined,
          options,
          { operationRef: operationId },
        ),
      operation: (operationId: string, options?: CallOptions) =>
        json(operationPath(operationId), c.operation, "GET", undefined, options, {
          operationRef: operationId,
        }),
      fence: (input: c.Fence, options?: CallOptions) =>
        mutate(
          "/v1/policy-fences",
          "POST",
          valid(c.fence, input),
          options,
          c.acknowledgementOperation,
        ),
    }),
  };
}
export function createManagementClient(settings: ManagementConfig) {
  const { client, json } = accountClient(settings, "management");
  return Object.freeze({
    ...client,
    prepare: (input: c.Prepare, options?: CallOptions) => {
      const parsed = valid(c.prepare, input);
      return json("/v1/executions", c.preparationOperation, "POST", parsed, options, {
        operationRef: parsed.operationId,
      });
    },
  });
}
export function createLifecycleClient(settings: LifecycleConfig) {
  const captured = valid(lifecycleConfig, settings);
  const base: ManagementConfig | ConsumerControlConfig = {
    role: captured.role,
    origin: captured.origin,
    token: captured.token,
    responseBytes: captured.responseBytes,
    timeoutMs: captured.timeoutMs,
    bufferBytes: captured.bufferBytes,
  };
  const { json } = transport(base, captured.role);
  const headers = {
    [c.LIFECYCLE_CAPABILITY_HEADER]: c.LIFECYCLE_CAPABILITY_CONTRACT,
    [c.LIFECYCLE_CLIENT_HEADER]: c.LIFECYCLE_CLIENT_CONTRACT,
  };
  const mutate = async (
    accountRef: string,
    action: "suspend" | "resume",
    input: c.LifecycleTransition,
    options?: CallOptions,
  ): Promise<c.LifecycleOperation> => {
    const parsed = valid(c.lifecycleTransition, input);
    const result = await json(
      `/v2/accounts/${id(accountRef)}/${action}`,
      c.lifecycleOperation,
      "POST",
      parsed,
      options,
      { operationRef: parsed.operationId },
      headers,
    );
    if (
      (result.state === "applied" ? result.result.account : result.account).accountRef !==
        accountRef ||
      result.intent.accountRef !== accountRef ||
      result.intent.action !== action ||
      result.intent.expectedMetadataRevision !== parsed.expectedMetadataRevision
    ) {
      throw new GatewayError("invalid_response", "effect_unknown", parsed.operationId);
    }
    return result;
  };
  return Object.freeze({
    capability: (options?: CallOptions) =>
      json(
        "/v2/capabilities/account-lifecycle",
        c.lifecycleCapability,
        "GET",
        undefined,
        options,
        {},
        headers,
      ),
    list: (input: c.ListQuery = {}, options?: CallOptions) => {
      const entries: [string, c.ListQuery[keyof c.ListQuery]][] = Object.entries(
        valid(c.listQuery, input),
      );
      const query = new URLSearchParams(
        entries
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );
      return json(
        query.size ? `/v2/accounts?${query}` : "/v2/accounts",
        c.lifecycleAccounts,
        "GET",
        undefined,
        options,
        {},
        headers,
      );
    },
    get: async (accountRef: string, options?: CallOptions) => {
      const result = await json(
        `/v2/accounts/${id(accountRef)}`,
        c.lifecycleAccount,
        "GET",
        undefined,
        options,
        {},
        headers,
      );
      if (result.accountRef !== accountRef) {
        throw new GatewayError("invalid_response", "effect_unknown");
      }
      return result;
    },
    suspend: (accountRef: string, input: c.LifecycleTransition, options?: CallOptions) =>
      mutate(accountRef, "suspend", input, options),
    resume: (accountRef: string, input: c.LifecycleTransition, options?: CallOptions) =>
      mutate(accountRef, "resume", input, options),
    operation: (operationId: string, options?: CallOptions) =>
      json(
        `/v2/operations/${id(operationId)}`,
        c.lifecycleOperation,
        "GET",
        undefined,
        options,
        { operationRef: operationId },
        headers,
      ),
  });
}
const runAccessResponse = z
  .strictObject({
    operation: c.preparationOperation,
    bearer: z.string().regex(/^[A-Za-z0-9._~-]{16,1024}$/),
    admission: c.admission,
  })
  .refine(
    (v) =>
      v.operation.state === "applied" &&
      v.operation.result?.kind === "execution" &&
      v.operation.result.accountRef === v.admission.accountRef &&
      v.operation.result.authorizationEpoch === v.admission.authorizationEpoch &&
      v.operation.result.deadline === v.admission.expiresAt,
  );
const consumerList = c.listQuery.extend({ ownerRef: c.reference });
export function createConsumerControlClient(settings: ConsumerControlConfig) {
  const { client, json } = accountClient(settings, "consumer-control");
  return Object.freeze({
    ...client,
    observeUsage: (
      executionRef: string,
      requestRef: string,
      options?: CallOptions,
    ): Promise<c.UsageObservation | null> =>
      json(
        `/v1/usage/${id(executionRef)}/${id(requestRef)}`,
        c.usageRead,
        "GET",
        undefined,
        options,
      ).then((result) => result.observation),
    listUsage: (input: c.UsageQuery = {}, options?: CallOptions): Promise<c.UsagePage> => {
      const query = valid(c.usageQuery, input);
      const params = new URLSearchParams();
      if (query.afterCursor !== undefined && query.afterCursor !== "") {
        params.set("afterCursor", query.afterCursor);
      }
      if (query.highWaterCursor !== undefined && query.highWaterCursor !== "") {
        params.set("highWaterCursor", query.highWaterCursor);
      }
      if (query.limit !== undefined && query.limit !== 0) {
        params.set("limit", String(query.limit));
      }
      return json(
        "/v1/usage" + (params.size ? "?" + params : ""),
        c.usagePage,
        "GET",
        undefined,
        options,
      );
    },
    list: (input: c.ListQuery & { ownerRef: string }, options?: CallOptions) =>
      client.list(valid(consumerList, input), options),
    runAccess: (input: c.Prepare, options?: CallOptions) => {
      const parsed = valid(c.prepare, input);
      return json("/internal/v1/run-access", runAccessResponse, "POST", parsed, options, {
        operationRef: parsed.operationId,
      });
    },
  });
}
export function createExecutionClient(settings: ExecutionConfig) {
  const { json, stream } = transport(settings, "execution");
  return Object.freeze({
    request: stream,
    status: (executionRef: string, requestId: string, options?: CallOptions) =>
      json(requestPath(executionRef, requestId), c.requestStatus, "GET", undefined, options, {
        requestRef: requestId,
      }),
    close: (executionRef: string, input: c.Close, options?: CallOptions) => {
      const parsed = valid(c.close, input);
      return json(
        `/v1/executions/${id(executionRef)}/close`,
        c.acknowledgementOperation,
        "POST",
        parsed,
        options,
        { operationRef: parsed.operationId },
      );
    },
    operation: (operationId: string, options?: CallOptions) =>
      json(operationPath(operationId), c.operation, "GET", undefined, options, {
        operationRef: operationId,
      }),
  });
}
export type ManagementClient = ReturnType<typeof createManagementClient>;
export type ExecutionClient = ReturnType<typeof createExecutionClient>;
export type ConsumerControlClient = ReturnType<typeof createConsumerControlClient>;
export type LifecycleClient = ReturnType<typeof createLifecycleClient>;

const accountLimitsConfig = config.extend({
  role: z.enum(["management", "consumer-control"]),
  responseBytes: z.number().int().min(1024).max(262144).default(262144),
  timeoutMs: z.number().int().min(1).max(3000).default(3000),
});
export type AccountLimitsConfig = z.input<typeof accountLimitsConfig>;
/** Server-only cached reads. No retry, credential refresh or provider request. */
export function createAccountLimitsClient(settings: AccountLimitsConfig) {
  const captured = valid(accountLimitsConfig, settings);
  const { json } = transport(captured, captured.role);
  return Object.freeze({
    getAccountLimitsCapabilities: (options?: CallOptions): Promise<c.AccountLimitsCapabilities> =>
      json(
        "/v1/capabilities/account-limits",
        c.accountLimitsCapabilities,
        "GET",
        undefined,
        options,
      ),
    readAccountLimits: (
      input: c.AccountLimitsRequest,
      options?: CallOptions,
    ): Promise<c.AccountLimits> =>
      json(
        "/v1/account-limits/read",
        c.accountLimits,
        "POST",
        valid(c.accountLimitsRequest, input),
        options,
      ),
  });
}
export type AccountLimitsClient = ReturnType<typeof createAccountLimitsClient>;

const accountLimitsV2Config = accountLimitsConfig.extend({
  contract: z.literal(c.ACCOUNT_LIMITS_V2_CONTRACT),
});
export type AccountLimitsV2Config = z.input<typeof accountLimitsV2Config>;
/** Version selected by declared capability; this client never probes v1 or retries. */
export function createAccountLimitsV2Client(settings: AccountLimitsV2Config) {
  const captured = valid(accountLimitsV2Config, settings);
  const { contract: _contract, ...transportConfig } = captured;
  const { json } = transport(transportConfig, captured.role);
  return Object.freeze({
    getAccountLimitsCapabilities: (options?: CallOptions): Promise<c.AccountLimitsV2Capabilities> =>
      json(
        "/v2/capabilities/account-limits",
        c.accountLimitsV2Capabilities,
        "GET",
        undefined,
        options,
      ),
    readAccountLimits: (
      input: c.AccountLimitsRequest,
      options?: CallOptions,
    ): Promise<c.AccountLimitsV2> =>
      json(
        "/v2/account-limits/read",
        c.accountLimitsV2,
        "POST",
        valid(c.accountLimitsRequest, input),
        options,
      ),
  });
}
export type AccountLimitsV2Client = ReturnType<typeof createAccountLimitsV2Client>;
