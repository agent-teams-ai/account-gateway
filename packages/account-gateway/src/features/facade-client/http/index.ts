import { z } from 'zod';
import * as c from '../contracts/index.js';

import { connect, reconnect, nativeRequest } from './ingress.js';
export * as secretSubmission from './ingress.js';
const config = z.strictObject({ role: z.enum(['management', 'execution']), origin: z.string().url(), token: z.string().min(1).max(16384),
  responseBytes: z.number().int().min(1024).max(1048576).default(65536), timeoutMs: z.number().int().min(1).max(3600000).default(30000),
  bufferBytes: z.number().int().min(1024).max(1048576).default(65536) });
export type ManagementConfig = z.input<typeof config> & { role: 'management' };
export type ExecutionConfig = z.input<typeof config> & { role: 'execution' };
export type Connect = z.infer<typeof connect>;
export type Reconnect = z.infer<typeof reconnect>;
export interface CallOptions { signal?: AbortSignal }
export class GatewayError extends Error {
  constructor(readonly code: 'invalid_input' | 'transport' | 'invalid_response' | 'cancelled' | 'safe_error',
    readonly effect: z.infer<typeof c.effectState>, readonly operationRef?: string, readonly requestRef?: string,
    readonly diagnostic?: c.SafeError) { super(`Account gateway: ${code}`); this.name = 'GatewayError'; }
}
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new GatewayError('invalid_input', 'not_dispatched');
  return result.data;
}
const id = (value: string) => encodeURIComponent(valid(c.reference, value));
export const operationPath = (operationId: string) => `/v1/operations/${id(operationId)}`;
export const requestPath = (executionRef: string, requestId: string) => `/v1/executions/${id(executionRef)}/requests/${id(requestId)}`;

type Identity = { operationRef?: string; requestRef?: string };
function transport(input: ManagementConfig | ExecutionConfig, role: 'management' | 'execution') {
  if (typeof process === 'undefined' || !process.versions?.node) throw new GatewayError('invalid_input', 'not_dispatched');
  const settings = valid(config, input);
  if (settings.role !== role) throw new GatewayError('invalid_input', 'not_dispatched');
  const origin = new URL(settings.origin);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname))))
    throw new GatewayError('invalid_input', 'not_dispatched');
  async function enter(path: string, method: string, body: string | Uint8Array | undefined, headers: Record<string, string>, options: CallOptions, identity: Identity) {
    if (options.signal?.aborted) throw new GatewayError('cancelled', 'not_dispatched', identity.operationRef, identity.requestRef);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const failure = (code: 'transport' | 'invalid_response' | 'cancelled') => new GatewayError(code, 'effect_unknown', identity.operationRef, identity.requestRef);
    try {
      const response = await fetch(new URL(path, origin), { method, redirect: 'manual', signal: controller.signal,
        headers: { authorization: `Bearer ${settings.token}`, ...headers }, body: body as BodyInit | undefined });
      return { response, controller, dispose, failure };
    } catch { dispose(); throw failure(controller.signal.aborted ? 'cancelled' : 'transport'); }
  }
  async function bounded(response: Response, maximum: number): Promise<unknown> {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) throw new Error();
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function json<T>(path: string, schema: z.ZodType<T>, method = 'GET', input?: unknown, options: CallOptions = {}, identity: Identity = {}): Promise<T> {
    const handle = await enter(path, method, input === undefined ? undefined : JSON.stringify(input), { 'content-type': 'application/json', accept: 'application/json' }, options, identity);
    try {
      const { response } = handle;
      if (response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw handle.failure('invalid_response');
      const parsed = await bounded(response, settings.responseBytes);
      if (!response.ok) {
        const error = c.safeError.safeParse(parsed);
        if (!error.success || (identity.operationRef && error.data.operationRef && error.data.operationRef !== identity.operationRef) ||
          (identity.requestRef && error.data.requestRef && error.data.requestRef !== identity.requestRef)) throw handle.failure('invalid_response');
        // A missing readback record cannot establish absence of a prior effect.
        const readbackMissing = response.status === 404 && (path.startsWith('/v1/operations/') || path.includes('/requests/'));
        const diagnostic: c.SafeError = readbackMissing ? { ...error.data, effect: 'effect_unknown', retry: { kind: 'readback' } } : error.data;
        throw new GatewayError('safe_error', diagnostic.effect, identity.operationRef, identity.requestRef, diagnostic);
      }
      const result = schema.safeParse(parsed);
      if (!result.success) throw handle.failure('invalid_response');
      if (identity.operationRef && 'operationRef' in (result.data as object) && (result.data as c.Operation).operationRef !== identity.operationRef) throw handle.failure('invalid_response');
      if (identity.requestRef && 'requestRef' in (result.data as object) && (result.data as c.RequestStatus).requestRef !== identity.requestRef) throw handle.failure('invalid_response');
      if (response.status === 202 && 'state' in (result.data as object) && (result.data as c.Operation).state !== 'pending') throw handle.failure('invalid_response');
      return result.data;
    } catch (error) {
      const failure = error instanceof GatewayError ? error : handle.failure(handle.controller.signal.aborted ? 'cancelled' : 'invalid_response');
      handle.controller.abort(); throw failure;
    }
    finally { handle.dispose(); }
  }
  async function stream(executionRef: string, raw: NativeRequest, options: CallOptions = {}): Promise<NativeResponse> {
    const request = valid(nativeRequest, raw);
    const identity = { requestRef: request.requestId };
    const handle = await enter(`/v1/executions/${id(executionRef)}/requests`, 'POST', new Uint8Array(request.body), {
      'content-type': 'application/json', accept: 'text/event-stream', 'x-gateway-request-id': request.requestId,
      'x-gateway-admission': JSON.stringify(request.admission),
    }, options, identity);
    try {
      if (handle.response.status === 202 && handle.response.headers.get('content-type')?.split(';')[0] === 'application/json') {
        const status = c.requestStatus.safeParse(await bounded(handle.response, settings.responseBytes));
        if (!status.success || status.data.requestRef !== request.requestId) throw handle.failure('invalid_response');
        handle.dispose();
        return { kind: 'status', status: status.data };
      }
      if (!handle.response.ok) {
        const result = c.safeError.safeParse(await bounded(handle.response, settings.responseBytes));
        if (!result.success || (result.data.requestRef && result.data.requestRef !== request.requestId)) throw handle.failure('invalid_response');
        throw new GatewayError('safe_error', result.data.effect, undefined, request.requestId, result.data);
      }
      if (handle.response.status !== 200 || handle.response.headers.get('x-gateway-request-ref') !== request.requestId ||
        handle.response.headers.get('content-type')?.split(';')[0] !== 'text/event-stream' || !handle.response.body) throw handle.failure('invalid_response');
      const reader = handle.response.body.getReader();
      let size = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { handle.dispose(); controller.close(); return; }
            size += value.byteLength;
            if (value.byteLength > settings.bufferBytes || size > request.admission.limits.outputBytes) throw handle.failure('invalid_response');
            controller.enqueue(value);
          } catch (error) {
            const failure = error instanceof GatewayError ? error : handle.failure(handle.controller.signal.aborted ? 'cancelled' : 'transport');
            handle.controller.abort(); handle.dispose(); await reader.cancel().catch(() => {}); controller.error(failure);
          }
        },
        async cancel() { handle.controller.abort(); handle.dispose(); await reader.cancel().catch(() => {}); },
      }, { highWaterMark: 0 });
      return { kind: 'stream', requestRef: request.requestId, body, cancel: async () => { handle.controller.abort(); handle.dispose(); await reader.cancel().catch(() => {}); } };
    } catch (error) {
      const failure = error instanceof GatewayError ? error : handle.failure(handle.controller.signal.aborted ? 'cancelled' : 'invalid_response');
      handle.controller.abort(); handle.dispose(); throw failure;
    }
  }
  return { json, stream };
}
export type NativeResponse = { kind: 'stream'; requestRef: string; body: ReadableStream<Uint8Array>; cancel(): Promise<void> } | { kind: 'status'; status: c.RequestStatus };
export type NativeRequest = z.infer<typeof nativeRequest>;
export function createManagementClient(settings: ManagementConfig) {
  const { json } = transport(settings, 'management');
  const mutate = (path: string, method: string, input: { operationId: string }, options?: CallOptions, schema = c.accountOperation) => json(path, schema, method, input, options, { operationRef: input.operationId });
  return Object.freeze({
    profiles: (options?: CallOptions) => json('/v1/profiles', c.profiles, 'GET', undefined, options),
    list: (input: c.ListQuery = {}, options?: CallOptions) => {
      const query = new URLSearchParams(Object.entries(valid(c.listQuery, input)).map(([key, value]) => [key, String(value)]));
      return json(`/v1/accounts?${query}`, c.accounts, 'GET', undefined, options);
    },
    get: (accountRef: string, options?: CallOptions) => json(`/v1/accounts/${id(accountRef)}`, c.account, 'GET', undefined, options),
    connect: (input: Connect, options?: CallOptions) => mutate('/v1/accounts', 'POST', valid(connect, input), options),
    rename: (accountRef: string, input: c.Rename, options?: CallOptions) => mutate(`/v1/accounts/${id(accountRef)}`, 'PATCH', valid(c.rename, input), options),
    reconnect: (accountRef: string, input: Reconnect, options?: CallOptions) => mutate(`/v1/accounts/${id(accountRef)}/reconnect`, 'POST', valid(reconnect, input), options),
    disable: (accountRef: string, input: c.Disable, options?: CallOptions) => mutate(`/v1/accounts/${id(accountRef)}/disable`, 'POST', valid(c.disable, input), options),
    operation: (operationId: string, options?: CallOptions) => json(operationPath(operationId), c.operation, 'GET', undefined, options, { operationRef: operationId }),
    prepare: (input: c.Prepare, options?: CallOptions) => mutate('/v1/executions', 'POST', valid(c.prepare, input), options, c.preparationOperation),
    fence: (input: c.Fence, options?: CallOptions) => mutate('/v1/policy-fences', 'POST', valid(c.fence, input), options, c.acknowledgementOperation),
  });
}
export function createExecutionClient(settings: ExecutionConfig) {
  const { json, stream } = transport(settings, 'execution');
  return Object.freeze({
    request: stream,
    status: (executionRef: string, requestId: string, options?: CallOptions) => json(requestPath(executionRef, requestId), c.requestStatus, 'GET', undefined, options, { requestRef: requestId }),
    close: (executionRef: string, input: c.Close, options?: CallOptions) => {
      const parsed = valid(c.close, input);
      return json(`/v1/executions/${id(executionRef)}/close`, c.acknowledgementOperation, 'POST', parsed, options, { operationRef: parsed.operationId });
    },
    operation: (operationId: string, options?: CallOptions) => json(operationPath(operationId), c.operation, 'GET', undefined, options, { operationRef: operationId }),
  });
}
export type ManagementClient = ReturnType<typeof createManagementClient>;
export type ExecutionClient = ReturnType<typeof createExecutionClient>;
