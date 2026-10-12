import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { KernelError, identifier, uuid } from './domain.ts';
import { secretSubmission } from '@agent-teams/account-gateway/http';
import { oauthAuthorizationURL } from '@agent-teams/account-gateway/contracts';
import { codexOAuthProfile, codexOAuthCleanupModels, exactCandidate, physicalCandidate } from './management.ts';
import type { CandidateJournal, CandidateMapping, CandidateNative, NativeReadback, PhysicalCandidate } from './management.ts';
import type { OAuthScope, OAuthEnrollmentNative, OAuthReadback, OAuthBeginReadback, OAuthCallback } from './management.ts';
import type { OAuthDescriptor, OAuthDescriptorBoundary } from './management.ts';
import type { OAuthRefreshNative, OAuthRefreshReadback } from './management.ts';
import type { OAuthLifecycleNative, OAuthCleanupAuthority, OAuthCleanupAction, OAuthCleanupReadback } from './management.ts';

export type NativeFailureCode = 'unavailable' | 'deadline' | 'bounded' | 'redirect' | 'invalid_readback' | 'denied';
export class NativeFailure extends Error {
  readonly code: NativeFailureCode;
  // Any request failure may be effected. HTTP status alone never asserts NoEffect.
  readonly classification = 'uncertain';
  constructor(code: NativeFailureCode) { super(code); this.code = code; }
}
// Existing private Go wire, supplied at native source 16d621c2. This is not SDK v1.
const candidatesPath = '/private/native/v1/candidates';
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k)) ||
      keys.some(k => !Object.hasOwn(value,k))) throw new NativeFailure('invalid_readback');
  return value as Record<string, unknown>;
}
function decode(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // JSON.parse chooses the last duplicate. Reject decoded duplicate member names
  // (including escaped aliases) before accepting any physical identity or ACK.
  let position = 0;
  const space = (): void => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const c = text[position++];
      if (c === '\\') position++;
      else if (c === '"') return JSON.parse(text.slice(start,position)) as string;
    }
    throw new NativeFailure('invalid_readback');
  };
  const value = (depth: number): void => {
    space();
    if (text[position] === '{') {
      if (depth > 1) throw new NativeFailure('invalid_readback');
      position++; space(); const keys = new Set<string>();
      if (text[position] === '}') { position++; return; }
      while (position < text.length) {
        if (text[position] !== '"') throw new NativeFailure('invalid_readback');
        const key = string();
        if (keys.has(key)) throw new NativeFailure('invalid_readback');
        keys.add(key); space();
        if (text[position++] !== ':') throw new NativeFailure('invalid_readback');
        const start = position;
        value(depth + 1);
        if (key === 'account_id') {
          const token = text.slice(start,position).trim();
          // Check the original Go integer token before JSON.parse can round it.
          if (!/^[1-9][0-9]*$/.test(token) || BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new NativeFailure('invalid_readback');
          }
        }
        space();
        const next = text[position++];
        if (next === '}') return;
        if (next !== ',') throw new NativeFailure('invalid_readback');
        space();
      }
      throw new NativeFailure('invalid_readback');
    }
    if (text[position] === '[') throw new NativeFailure('invalid_readback');
    if (text[position] === '"') { string(); return; }
    const start = position;
    while (position < text.length && !/[\s,}]/.test(text[position])) position++;
    if (position === start) throw new NativeFailure('invalid_readback');
  };
  value(0); space();
  if (position !== text.length) throw new NativeFailure('invalid_readback');
  return JSON.parse(text) as unknown;
}
function readback(bytes: Buffer): NativeReadback {
  try {
    const r = object(decode(bytes),['descriptor','name','state','group_free','schedulable','probes_enabled']);
    const d = object(r.descriptor,['account_id','generation','created_at','profile','base_url','model']);
    if (typeof r.name !== 'string' || Buffer.byteLength(r.name) < 1 || Buffer.byteLength(r.name) > 400 ||
        !['inactive','active'].includes(r.state as string) || r.group_free !== true ||
        r.schedulable !== false || r.probes_enabled !== false) throw new NativeFailure('invalid_readback');
    const descriptor = physicalCandidate({ generation: d.generation as string,
      nativePhysicalIdentity: d.generation as string, nativeId: d.account_id as number,
      createdAt: d.created_at as string, profile: d.profile as string, baseURL: d.base_url as string, model: d.model as string });
    return Object.freeze({ ...descriptor,state: r.state as 'inactive' | 'active' });
  } catch { throw new NativeFailure('invalid_readback'); }
}
function wireDescriptor(d: PhysicalCandidate): object {
  return { account_id: d.nativeId,generation: d.generation,created_at: d.createdAt,
    profile: d.profile,base_url: d.baseURL,model: d.model };
}
function oauthPhysical(value: unknown, generation: string, cleanupOnly = false): PhysicalCandidate {
  const d = object(value, ['account_id','generation','created_at','profile','base_url','model']);
  const native = physicalCandidate({ nativeId: d.account_id as number, generation: d.generation as string,
    nativePhysicalIdentity: d.generation as string, createdAt: d.created_at as string,
    profile: d.profile as string, baseURL: d.base_url as string, model: d.model as string });
  if (native.generation !== generation || native.profile !== codexOAuthProfile.profile ||
      native.baseURL !== codexOAuthProfile.baseURL ||
      (cleanupOnly ? !codexOAuthCleanupModels.includes(native.model) : native.model !== codexOAuthProfile.model)) throw new NativeFailure('invalid_readback');
  return native;
}
export interface NativeManagementOptions {
  readonly origin: string; readonly consumerId: string; readonly controlCredential: string;
  readonly deadlineMs?: number; readonly bodyBytes?: number; readonly headerBytes?: number;
}
// One concrete bounded transport shared by the two private control adapters.
// It carries no enrollment policy and never performs a second HTTP attempt.
class NativeControlHTTP {
  readonly #origin: URL;
  readonly #consumer: string;
  readonly #control: string;
  readonly #deadlineMs: number;
  readonly #bodyBytes: number;
  readonly #headerBytes: number;
  constructor(options: NativeManagementOptions) {
    let origin: URL;
    try { origin = new URL(options.origin); } catch { throw new KernelError('invalid'); }
    if (!(origin.protocol === 'https:' || (origin.protocol === 'http:' &&
        ['127.0.0.1','[::1]'].includes(origin.hostname))) || origin.pathname !== '/' ||
        origin.username || origin.password || origin.search || origin.hash) throw new KernelError('invalid');
    identifier(options.consumerId);
    if (typeof options.controlCredential !== 'string' || options.controlCredential.length < 1 ||
        options.controlCredential.length > 2048 || !/^[A-Za-z0-9._~+/-]+=*$/.test(options.controlCredential)) throw new KernelError('invalid');
    const deadlineMs = options.deadlineMs ?? 5000, bodyBytes = options.bodyBytes ?? 65_536, headerBytes = options.headerBytes ?? 16_384;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000 ||
        !Number.isInteger(bodyBytes) || bodyBytes < 1 || bodyBytes > 262_144 ||
        !Number.isInteger(headerBytes) || headerBytes < 1024 || headerBytes > 16_384) throw new KernelError('invalid');
    this.#origin = origin; this.#consumer = options.consumerId; this.#control = options.controlCredential;
    this.#deadlineMs = deadlineMs; this.#bodyBytes = bodyBytes; this.#headerBytes = headerBytes;
  }
  protected scope(scope: Pick<CandidateJournal, 'consumerId' | 'generation' | 'accountRef' | 'ownerRef'>): void {
    if (scope.consumerId !== this.#consumer) throw new NativeFailure('denied');
    uuid(scope.generation); uuid(scope.accountRef); identifier(scope.ownerRef);
  }
  protected async call(method: 'POST' | 'GET' | 'PUT', path: string, value?: unknown,
    deadlineMs = this.#deadlineMs): Promise<Buffer> {
    let body: Buffer | undefined;
    try {
      body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
      if (body && body.length > (path === '/private/native/v1/oauth/connect/complete' ? 32_768 : 16_384)) throw new NativeFailure('bounded');
    } catch { throw new NativeFailure('bounded'); }
    return new Promise<Buffer>((resolve, reject) => {
      let finished = false;
      const finish = (error?: NativeFailure, bytes?: Buffer): void => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(bytes ?? Buffer.alloc(0));
      };
      const send = this.#origin.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(this.#origin, {
        method, path, agent: false, maxHeaderSize: this.#headerBytes,
        headers: { authorization: 'Bearer ' + this.#control, accept: 'application/json',
          connection: 'close', ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) },
      });
      req.maxHeadersCount = 65;
      const timer = setTimeout(() => { finish(new NativeFailure('deadline')); req.destroy(); }, Math.min(deadlineMs, this.#deadlineMs));
      req.on('error', () => finish(new NativeFailure('unavailable')));
      req.on('response', res => {
        // Retain one overflow sentinel beyond 64 pairs; Node truncates the rest.
        if (res.rawHeaders.length > 128) {
          finish(new NativeFailure('bounded')); res.destroy(); req.destroy(); return;
        }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(new NativeFailure(status >= 300 && status < 400 ? 'redirect' : 'unavailable'));
          res.destroy(); req.destroy(); return;
        }
        const chunks: Buffer[] = []; let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.#bodyBytes) { finish(new NativeFailure('bounded')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('aborted', () => finish(new NativeFailure('unavailable')));
        res.on('error', () => finish(new NativeFailure('unavailable')));
        res.on('end', () => finish(undefined, Buffer.concat(chunks)));
      });
      // No redirect handler, reuse agent, retry, provider route or consumer bearer.
      if (body) req.end(body); else req.end();
    });
  }
}
export class NativeManagementClient extends NativeControlHTTP implements CandidateNative {
  async create(input: CandidateJournal, displayName: string, apiKey: string): Promise<void> {
    const scope = { consumerId: input.consumerId, generation: input.generation, accountRef: input.accountRef,
      ownerRef: input.ownerRef, profile: input.profile.profile };
    this.scope(scope);
    uuid(scope.generation); uuid(scope.accountRef); identifier(scope.ownerRef); identifier(scope.profile, 64);
    if (typeof displayName !== 'string' || !displayName.isWellFormed() || displayName.length < 1 || displayName.length > 128 || Buffer.byteLength(displayName) > 400 || typeof apiKey !== 'string' ||
        !apiKey.isWellFormed() || Buffer.byteLength(apiKey) < 1 || Buffer.byteLength(apiKey) > 4096 || apiKey.trim() !== apiKey) throw new NativeFailure('bounded');
    await this.call('POST', candidatesPath, { generation: scope.generation, profile: scope.profile,
      name: displayName, api_key: apiKey, owner_ref: scope.ownerRef, account_ref: scope.accountRef });
  }
  async read(input: CandidateJournal): Promise<readonly NativeReadback[]> {
    this.scope(input);
    const generation = input.generation;
    const result = readback(await this.call('GET', candidatesPath + '/' + generation));
    if (!exactCandidate(input, result)) throw new NativeFailure('invalid_readback');
    return Object.freeze([result]);
  }
  private descriptor(input: CandidateMapping): PhysicalCandidate {
    this.scope(input);
    const d = physicalCandidate(input.descriptor);
    if (d.generation !== input.generation || d.nativePhysicalIdentity !== input.generation ||
        d.profile !== input.profile.profile || d.baseURL !== input.profile.baseURL || d.model !== input.profile.model) throw new NativeFailure('denied');
    return d;
  }
  async setState(input: CandidateMapping, state: 'active' | 'inactive'): Promise<void> {
    const d = this.descriptor(input);
    if (!['active','inactive'].includes(state)) throw new NativeFailure('denied');
    // The PUT ACK itself does not authorize promotion; orchestration uses an exact GET.
    const response = readback(await this.call('PUT', candidatesPath + '/' + d.generation,
      { descriptor: wireDescriptor(d),state }));
    if (response.state !== state || response.generation !== d.generation || response.nativeId !== d.nativeId ||
        response.createdAt !== d.createdAt || response.profile !== d.profile || response.baseURL !== d.baseURL || response.model !== d.model) throw new NativeFailure('invalid_readback');
  }
  async erase(input: CandidateMapping): Promise<void> {
    const d = this.descriptor(input);
    const bytes = await this.call('POST', candidatesPath + '/' + d.generation + '/erase', { descriptor: wireDescriptor(d) });
    try {
      const ack = object(decode(bytes),['state','credentials_erased']);
      if (ack.state !== 'tombstoned' || ack.credentials_erased !== true) throw new NativeFailure('invalid_readback');
    } catch { throw new NativeFailure('invalid_readback'); }
  }
}

// The trusted outer composition binds a concrete consumer AND original owner.
// Completed custody remains pending until separate exact descriptor readback.
export class NativeOAuthEnrollmentClient extends NativeControlHTTP implements OAuthEnrollmentNative, OAuthDescriptorBoundary, OAuthRefreshNative {
  readonly #owner: string;
  constructor(options: NativeManagementOptions & { readonly ownerRef: string }) {
    super(options);
    identifier(options.ownerRef);
    this.#owner = options.ownerRef;
  }
  private capture(input: OAuthScope): OAuthScope {
    const scope = Object.freeze({ consumerId: input.consumerId, operationId: input.operationId,
      ownerRef: input.ownerRef, accountRef: input.accountRef, generation: input.generation });
    this.scope(scope); identifier(scope.operationId);
    if (scope.ownerRef !== this.#owner) throw new NativeFailure('denied');
    return scope;
  }
  private wire(scope: OAuthScope): object {
    // Exact native input; no client, redirect, endpoint, profile, display name,
    // PKCE verifier or credential is accepted from the consumer. Completion
    // adds only the separately validated callback state/code to this tuple.
    return { operation: scope.operationId, owner_ref: scope.ownerRef,
      account_ref: scope.accountRef, generation: scope.generation };
  }
  private ack(bytes: Buffer, scope: OAuthScope, begin: boolean): OAuthBeginReadback {
    try {
      const r = object(decode(bytes), ['operation','account_ref','state'],
        begin ? ['outcome','authorize_url'] : ['outcome']);
      if (r.operation !== scope.operationId || r.account_ref !== scope.accountRef ||
          !['prepared','entered','completed','expired','unknown'].includes(r.state as string)) throw new NativeFailure('invalid_readback');
      // Native outcome is not a safe DTO or a no-effect receipt. Validate its
      // bounded primitive shape then discard; never reflect vendor diagnostics.
      if (Object.hasOwn(r, 'outcome') && (typeof r.outcome !== 'string' ||
          !/^[a-z][a-z0-9_]{0,63}$/.test(r.outcome))) throw new NativeFailure('invalid_readback');
      let authorizationURL: string | undefined;
      if (Object.hasOwn(r, 'authorize_url')) {
        if (!begin || r.state !== 'prepared') throw new NativeFailure('invalid_readback');
        const parsed = oauthAuthorizationURL.safeParse(r.authorize_url);
        if (!parsed.success) throw new NativeFailure('invalid_readback');
        authorizationURL = parsed.data;
      }
      return Object.freeze({ operationId: scope.operationId, accountRef: scope.accountRef,
        state: r.state as OAuthReadback['state'], ...(authorizationURL === undefined ? {} : { authorizationURL }) });
    } catch { throw new NativeFailure('invalid_readback'); }
  }
  async begin(input: OAuthScope): Promise<OAuthBeginReadback> {
    const scope = this.capture(input);
    return this.ack(await this.call('POST', '/private/native/v1/oauth/connect', this.wire(scope)), scope, true);
  }
  async complete(input: OAuthScope, callback: OAuthCallback): Promise<OAuthReadback> {
    const scope = this.capture(input), state = callback.state, code = callback.code;
    if (!secretSubmission.oauthCallbackState.safeParse(state).success ||
        !secretSubmission.oauthCallbackCode.safeParse(code).success) throw new NativeFailure('bounded');
    const result = this.ack(await this.call('POST', '/private/native/v1/oauth/connect/complete',
      { ...this.wire(scope), state, code }), scope, false);
    return Object.freeze({ operationId: result.operationId, accountRef: result.accountRef, state: result.state });
  }
  async read(input: OAuthScope): Promise<OAuthReadback> {
    const scope = this.capture(input);
    const result = this.ack(await this.call('POST', '/private/native/v1/oauth/connect/read', this.wire(scope)), scope, false);
    return Object.freeze({ operationId: result.operationId, accountRef: result.accountRef, state: result.state });
  }
  async refresh(input: OAuthScope): Promise<OAuthRefreshReadback> {
    const scope = this.capture(input);
    const bytes = await this.call('POST', '/private/native/v1/oauth/refresh', this.wire(scope), 5000);
    try {
      const r = object(decode(bytes), ['operation','account_ref','state'], ['refresh_ref']);
      if (r.operation !== scope.operationId || r.account_ref !== scope.accountRef ||
          !['idle','prepared','entered','completed','unknown'].includes(r.state as string)) throw new NativeFailure('invalid_readback');
      if (Object.hasOwn(r, 'refresh_ref')) identifier(r.refresh_ref);
      return Object.freeze({ operationId: scope.operationId, accountRef: scope.accountRef,
        state: r.state as OAuthRefreshReadback['state'],
        ...(Object.hasOwn(r, 'refresh_ref') ? { refreshRef: r.refresh_ref as string } : {}) });
    } catch { throw new NativeFailure('invalid_readback'); }
  }
  async describe(input: OAuthScope): Promise<OAuthDescriptor> {
    const scope = this.capture(input);
    const bytes = await this.call('POST', '/private/native/v1/oauth/connect/descriptor', this.wire(scope));
    try {
      const r = object(decode(bytes), ['operation','account_ref','state','qualification'], ['native']);
      if (r.operation !== scope.operationId || r.account_ref !== scope.accountRef) throw new NativeFailure('invalid_readback');
      const logical = { operationId: scope.operationId, accountRef: scope.accountRef };
      if (r.state === 'staged' && r.qualification === 'pending' && !Object.hasOwn(r, 'native')) {
        return Object.freeze({ ...logical, state: 'staged', qualification: 'pending' });
      }
      if (r.state !== 'staged' || r.qualification !== 'controlled-source-v1') throw new NativeFailure('invalid_readback');
      const native = oauthPhysical(r.native, scope.generation);
      return Object.freeze({ ...logical, state: 'qualified', qualification: 'controlled-source-v1', native });
    } catch { throw new NativeFailure('invalid_readback'); }
  }
}

// Purpose-bound cleanup credential is composed separately from connect/control.
export class NativeOAuthLifecycleClient extends NativeControlHTTP implements OAuthLifecycleNative {
  readonly #owner: string;
  constructor(options: NativeManagementOptions & { readonly ownerRef: string }) {
    super(options); identifier(options.ownerRef); this.#owner = options.ownerRef;
  }
  async cleanup(input: OAuthScope, authority: OAuthCleanupAuthority, action: OAuthCleanupAction): Promise<OAuthCleanupReadback> {
    const scope = Object.freeze({ consumerId: input.consumerId, operationId: input.operationId,
      ownerRef: input.ownerRef, accountRef: input.accountRef, generation: input.generation });
    const cleanupRef = authority.cleanupRef, cleanupToken = authority.cleanupToken;
    this.scope(scope); identifier(scope.operationId); uuid(cleanupRef); uuid(cleanupToken);
    if (scope.ownerRef !== this.#owner || !['read','erase'].includes(action)) throw new NativeFailure('denied');
    const bytes = await this.call('POST', '/private/native/v1/oauth/connect/cleanup', {
      operation: scope.operationId, owner_ref: scope.ownerRef, account_ref: scope.accountRef,
      generation: scope.generation, action, cleanup_ref: cleanupRef, cleanup_token: cleanupToken });
    try {
      const r = object(decode(bytes), ['operation','account_ref','credentials_erased','closure'], ['native']);
      if (r.operation !== scope.operationId || r.account_ref !== scope.accountRef || typeof r.credentials_erased !== 'boolean' ||
          !['pending','closed','unknown'].includes(r.closure as string) || r.closure === 'closed' && !r.credentials_erased) throw new NativeFailure('invalid_readback');
      const native = Object.hasOwn(r, 'native') ? oauthPhysical(r.native, scope.generation, true) : undefined;
      return Object.freeze({ operationId: scope.operationId, accountRef: scope.accountRef,
        credentialsErased: r.credentials_erased, closure: r.closure as OAuthCleanupReadback['closure'], ...(native ? { native } : {}) });
    } catch { throw new NativeFailure('invalid_readback'); }
  }
}
