import { z } from "zod";
import * as c from "../contracts/index.js";
import { nativeRequest } from "./ingress.js";

// One bounded HTTP transport: authorization, redaction, cancellation and
// uncertain-effects semantics remain shared across all SDK clients.
export const config = z.strictObject({
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
export function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }
  return result.data;
}
export const id = (value: string) => encodeURIComponent(valid(c.reference, value));
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
export function transport(
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
