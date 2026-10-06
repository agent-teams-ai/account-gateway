import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import * as c from '@agent-teams/account-gateway/contracts';
import { secretSubmission } from '@agent-teams/account-gateway/http';
import { KernelError, identifier, uuid } from './domain.ts';
import type { ApprovedLimits, ClaimResult, DurableKernel, ExecutionRead, NativeDispatchProof,
  OperationStatus, PrivateAdmission, RequestStatus, SavedExecution, TrustedContext, CleanupAuthority } from './domain.ts';
import { captureContext, physicalCandidate, codexOAuthProfile } from './management.ts';
import type { AccountManagement, ManagementStore, PhysicalCandidate } from './management.ts';
import { strictJSON, validateResponses } from './facade-ingress.ts';

interface Schema<T> { parse(value: unknown): T; safeParse(value: unknown): { success: boolean; data?: T } }
function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new KernelError('invalid');
  return result.data as T;
}
export interface PreparationPolicy {
  readonly accountRefs: readonly string[];
  readonly subjectRef: string;
  readonly policyRevision: number;
  readonly bindingRevision: number;
  readonly profileId: string;
  readonly limits: ApprovedLimits;
  readonly maxRunMs: number;
}
export interface ManagementBearer {
  readonly token: string; readonly role: 'management'; readonly consumerId: string;
  readonly ownerRefs: readonly string[]; readonly preparation: PreparationPolicy;
}
export interface ExecutionBearer {
  readonly token: string; readonly role: 'execution'; readonly consumerId: string;
  // Supplied only by trusted backend composition from the persisted prepare.
  readonly saved: SavedExecution;
}
// A distinct RR backend credential, never an execution or management upgrade.
export interface RunControlBearer {
  readonly token: string; readonly role: 'run-control'; readonly consumerId: string;
  readonly ownerRefs: readonly string[]; readonly profileIds: readonly string[];
  readonly limits: ApprovedLimits; readonly maxRunMs: number;
}
export interface RunAccess {
  readonly operation: c.Operation; readonly bearer: string; readonly admission: c.Admission;
}
export type ConfiguredBearer = ManagementBearer | ExecutionBearer | RunControlBearer;
type RunControlGrant = Omit<RunControlBearer, 'token'>;
type Grant = Omit<ManagementBearer, 'token'> | Omit<ExecutionBearer, 'token'> | RunControlGrant;
function savedCopy(s: SavedExecution): SavedExecution {
  const a = s.admission;
  const wire = parse(c.admission, { invocationRef: a.invocationRef, attemptRef: a.attemptRef, accountRef: a.accountRef,
    authorizationEpoch: a.authorizationEpoch, subjectRef: a.subjectRef, policyRevision: a.policyRevision,
    bindingRevision: a.bindingRevision, profileId: a.profileId, limits: { ...a.limits }, expiresAt: a.expiresAt });
  uuid(a.executionRef); uuid(a.issuerEpoch); uuid(s.generation);
  Object.freeze(wire.limits);
  return Object.freeze({ generation: s.generation, state: s.state, dispatchAllowed: s.dispatchAllowed,
    admission: Object.freeze({ ...wire, executionRef: a.executionRef, issuerEpoch: a.issuerEpoch }) });
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest();
// One bounded server mapping. Explicit configuration replacement revokes old
// captured authorities; run issuance only upserts its own execution entry.
export class FacadeBearers {
  #entries: readonly { hash: Buffer; grant: Grant; issuedBy?: RunControlGrant; token?: string }[] = [];
  constructor(entries: readonly ConfiguredBearer[]) { this.replace(entries); }
  replace(entries: readonly ConfiguredBearer[]): void {
    if (entries.length > 128) throw new KernelError('invalid');
    const next: { hash: Buffer; grant: Grant }[] = [];
    for (const entry of entries) {
      if (!/^[A-Za-z0-9._~-]{16,1024}$/.test(entry.token)) throw new KernelError('invalid');
      identifier(entry.consumerId);
      const hash = tokenHash(entry.token);
      if (next.some(row => timingSafeEqual(row.hash, hash))) throw new KernelError('invalid');
      let grant: Grant;
      if (entry.role === 'execution') {
        grant = Object.freeze({ role: entry.role, consumerId: entry.consumerId, saved: savedCopy(entry.saved) });
      } else if (entry.role === 'run-control') {
        if (!entry.ownerRefs.length || entry.ownerRefs.length > 100 || !entry.profileIds.length || entry.profileIds.length > 128 ||
            !Number.isSafeInteger(entry.maxRunMs) || entry.maxRunMs < 1 || entry.maxRunMs > 3_600_000 ||
            entry.limits.concurrency > entry.limits.requests) throw new KernelError('invalid');
        entry.ownerRefs.forEach(value => parse(c.reference, value));
        entry.profileIds.forEach(value => { parse(c.reference, value); identifier(value, 64); });
        grant = Object.freeze({ role: 'run-control', consumerId: entry.consumerId,
          ownerRefs: Object.freeze([...entry.ownerRefs]), profileIds: Object.freeze([...entry.profileIds]),
          limits: Object.freeze(parse(c.limits, entry.limits)), maxRunMs: entry.maxRunMs });
      } else {
        const p = entry.preparation;
        if (entry.role !== 'management' || !entry.ownerRefs.length || entry.ownerRefs.length > 100 ||
            p.accountRefs.length > 16 || !Number.isSafeInteger(p.maxRunMs) ||
            p.maxRunMs < 1 || p.maxRunMs > 3_600_000 || p.limits.concurrency > p.limits.requests) throw new KernelError('invalid');
        entry.ownerRefs.forEach(value => parse(c.reference, value));
        p.accountRefs.forEach(uuid); parse(c.reference, p.subjectRef); parse(c.reference, p.profileId);
        parse(c.revision, p.policyRevision); parse(c.revision, p.bindingRevision);
        grant = Object.freeze({ role: 'management', consumerId: entry.consumerId,
          ownerRefs: Object.freeze([...entry.ownerRefs]), preparation: Object.freeze({ ...p,
            accountRefs: Object.freeze([...p.accountRefs]), limits: Object.freeze(parse(c.limits, p.limits)) }) });
      }
      next.push({ hash, grant });
    }
    this.#entries = next;
  }
  resolve(token: string): Grant | undefined {
    const hash = tokenHash(token);
    let found: Grant | undefined;
    for (const row of this.#entries) if (timingSafeEqual(row.hash, hash)) found = row.grant;
    return found;
  }
  current(grant: Grant): boolean { return this.#entries.some(row => row.grant === grant); }
  // Protected owner lookup uses current management policy, never a raw bearer
  // or a cached consumer-to-owner association. Replacement revokes immediately.
  authorizesOwner(context: TrustedContext, ownerRef: string, profileId: string): boolean {
    return this.#entries.some(({ grant }) => grant.role === 'management' &&
      grant.consumerId === context.consumerId && grant.ownerRefs.includes(ownerRef) &&
      grant.preparation.profileId === profileId);
  }
  // Synchronous CAS after SQL read: identical issuance retains its token and
  // original saved tuple. No neighboring grant is replaced or evicted.
  upsertExecution(control: RunControlGrant, input: SavedExecution): string {
    if (control.role !== 'run-control' || !this.current(control)) throw new KernelError('denied');
    const saved = savedCopy(input);
    if (!saved.dispatchAllowed || saved.state !== 'open' || Date.parse(saved.admission.expiresAt) <= Date.now()) throw new KernelError('denied');
    const old = this.#entries.find(row => row.issuedBy === control && row.grant.role === 'execution' &&
      row.grant.consumerId === control.consumerId && row.grant.saved.admission.executionRef === saved.admission.executionRef);
    if (old) {
      if (old.grant.role !== 'execution' || !sameSaved(old.grant.saved, saved) || !old.token) throw new KernelError('conflict');
      return old.token;
    }
    if (this.#entries.length >= 128) throw new KernelError('unavailable');
    const token = randomBytes(32).toString('base64url');
    const grant = Object.freeze({ role: 'execution' as const, consumerId: control.consumerId, saved });
    this.#entries = [...this.#entries, { hash: tokenHash(token), grant, issuedBy: control, token }];
    return token;
  }
}
export interface NativeEnrollment {
  readonly originRef: string; readonly engineIncarnation: string; readonly worker: string;
}
export interface NativePermit {
  readonly claim: ClaimResult;
  readonly physical?: PhysicalCandidate;
  readonly permitExpiresAt?: string;
}
export interface NativeCallback {
  // A directly composed protected callback. The native adapter authenticates its
  // enrolled peer before invoking this capability; it is never a public route.
  admit(requestNonce: string): Promise<NativePermit>;
  effect(proof: NativeDispatchProof, next: 'response_started' | 'completed' | 'effect_unknown'): Promise<RequestStatus>;
  rejectBeforeDispatch(proof: NativeDispatchProof, entered: false): Promise<RequestStatus>;
  closed(proof: NativeDispatchProof, cleanup?: CleanupAuthority): Promise<void>;
}
export interface NativeTransport {
  // One request/reservation, no retry. Payload is unchanged; Go alone applies
  // approved cap normalization and native SSE/tool conversion.
  request(input: { readonly context: TrustedContext; readonly saved: SavedExecution;
    readonly requestId: string; readonly body: Uint8Array; readonly signal: AbortSignal;
    readonly callback: NativeCallback }): Promise<
      { readonly kind: 'status' } |
      { readonly kind: 'stream'; readonly body: AsyncIterable<Uint8Array>; cancel(): Promise<void> }>;
  // Only exact persisted closure proof/current cleanup lease can reach native.
  cancel?(context: TrustedContext, proof: NativeDispatchProof, cleanup: CleanupAuthority): Promise<void>;
}
export interface FacadeOptions {
  readonly kernel: DurableKernel & ExecutionRead;
  readonly management: AccountManagement;
  readonly store: Pick<ManagementStore, 'mapping'>;
  readonly bearers: FacadeBearers;
  readonly profiles: readonly { readonly dto: c.Profile; readonly maxOutputTokens: number;
    readonly limits?: Readonly<ApprovedLimits> }[];
  readonly intentHmacKey: Uint8Array;
  readonly enrollment?: NativeEnrollment;
  readonly transport?: NativeTransport;
  readonly ingressBytes?: number;
  readonly timeoutMs?: number;
  readonly bufferBytes?: number;
}
function admissionTuple(a: PrivateAdmission): readonly unknown[] {
  return [a.executionRef, a.issuerEpoch, a.invocationRef, a.attemptRef, a.accountRef, a.authorizationEpoch,
    a.subjectRef, a.policyRevision, a.bindingRevision, a.profileId, a.expiresAt,
    a.limits.requests, a.limits.concurrency, a.limits.requestBytes, a.limits.outputBytes, a.limits.tokens];
}
function sameSaved(a: SavedExecution, b: SavedExecution): boolean {
  return a.generation === b.generation && JSON.stringify(admissionTuple(a.admission)) === JSON.stringify(admissionTuple(b.admission));
}
function safe(code: c.SafeError['code'], effect: c.SafeError['effect'] = 'effect_unknown', identity: { operationRef?: string; requestRef?: string } = {}): c.SafeError {
  return c.safeError.parse({ code, traceRef: randomUUID(), ...identity, effect,
    retry: { kind: effect === 'effect_unknown' ? 'readback' : 'never' } });
}
function requestDTO(r: RequestStatus): c.RequestStatus {
  const status = r.effect === 'completed' ? 'completed' : r.effect === 'effect_unknown' ? 'unknown' :
    ['not_dispatched', 'rejected_before_dispatch'].includes(r.effect) ? 'failed' : 'pending';
  return c.requestStatus.parse({ requestRef: r.requestRef, effect: r.effect, status,
    ...(status === 'failed' || status === 'unknown' ? { error: safe(r.code === 'limit' ? 'admission_limited' : 'upstream_failure', r.effect, { requestRef: r.requestRef }) } : {}) });
}
function accountDTO(a: Awaited<ReturnType<AccountManagement['account']>>): c.Account {
  return c.account.parse({ accountRef: a.accountRef, ownerRef: a.ownerRef, profileId: a.profile,
    displayName: a.displayName, state: a.state, metadataRevision: a.revision, authorizationEpoch: a.epoch });
}
const executionState = (state: SavedExecution['state']): c.Execution['state'] => state === 'open' ? 'active' : state === 'closed' ? 'terminal' : 'fenced';
function singleton(req: IncomingMessage, name: string, required = true): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  if (values.length !== (required ? 1 : 0) && !(values.length === 1 && !required)) throw new KernelError('invalid');
  return values[0];
}
async function body(req: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const content = singleton(req, 'content-type');
  if (content !== 'application/json') throw new KernelError('invalid');
  const encoding = singleton(req, 'content-encoding', false);
  if (encoding !== undefined) throw new KernelError('invalid');
  const length = singleton(req, 'content-length', false);
  if (length !== undefined && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > maximum)) throw new KernelError('invalid');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Uint8Array); size += part.byteLength;
    if (size > maximum) throw new KernelError('invalid');
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}
function send<T>(res: ServerResponse, schema: Pick<Schema<T>, 'parse'>, value: T, status = 200): void {
  const bytes = JSON.stringify(schema.parse(value));
  if (Buffer.byteLength(bytes) > 65_536) throw new KernelError('unavailable');
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(bytes) });
  res.end(bytes);
}

// Cleanup is a separate exact leased authority. A successful outbound cancel
// does not certify provider transport closure or release SQL occupancy.
export async function cancelFacadeTransport(options: FacadeOptions, context: TrustedContext,
  input: NativeDispatchProof, authority: CleanupAuthority): Promise<void> {
  const ctx = captureContext(context), proof = { executionRef: input.executionRef, requestRef: input.requestRef,
    worker: input.worker, token: input.token, native: { originRef: input.native.originRef, engineIncarnation: input.native.engineIncarnation, requestNonce: input.native.requestNonce, generation: input.native.generation } },
    cleanup = { cleanupRef: authority.cleanupRef, token: authority.token };
  const configured = options.enrollment, transport = options.transport, kernel = options.kernel;
  if (!configured || !transport?.cancel) throw new KernelError('unavailable');
  const peer = { originRef: configured.originRef, engineIncarnation: configured.engineIncarnation, worker: configured.worker };
  if (proof.native.originRef !== peer.originRef || proof.native.engineIncarnation !== peer.engineIncarnation) throw new KernelError('denied');
  const transports = await kernel.cleanupTransports(ctx, cleanup.cleanupRef, peer.worker, cleanup.token);
  if (!transports.some(p => p.executionRef === proof.executionRef && p.requestRef === proof.requestRef &&
      p.worker === proof.worker && p.token === proof.token && p.native?.originRef === proof.native.originRef &&
      p.native.engineIncarnation === proof.native.engineIncarnation && p.native.requestNonce === proof.native.requestNonce &&
      p.native.generation === proof.native.generation)) throw new KernelError('denied');
  await transport.cancel(ctx, proof, cleanup);
}

export function createFacade(options: FacadeOptions): Server {
  const kernel = options.kernel, management = options.management, store = options.store, bearers = options.bearers;
  const ingressBytes = options.ingressBytes ?? 1_048_576, timeoutMs = options.timeoutMs ?? 30_000, bufferBytes = options.bufferBytes ?? 65_536;
  if (!Number.isSafeInteger(ingressBytes) || ingressBytes < 1024 || ingressBytes > 16_777_216 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 ||
      !Number.isSafeInteger(bufferBytes) || bufferBytes < 1024 || bufferBytes > 1_048_576 || options.intentHmacKey.byteLength !== 32) throw new KernelError('invalid');
  const hmac = Buffer.from(options.intentHmacKey);
  const profiles = new Map<string, { dto: c.Profile; maxOutputTokens: number; limits?: Readonly<ApprovedLimits> }>();
  for (const entry of options.profiles) {
    const dto = c.profile.parse(entry.dto);
    const oauth = dto.authKinds[0] === 'oauth';
    if (dto.protocol !== 'openai-responses' || dto.modelIds.length !== 1 || dto.authKinds.length !== 1 ||
        (oauth ? !management.supportsOAuthProfile(dto.profileId) || dto.profileId !== codexOAuthProfile.profile ||
          dto.modelIds[0] !== codexOAuthProfile.model : dto.authKinds[0] !== 'api_key' || dto.profileId === codexOAuthProfile.profile) ||
        profiles.has(dto.profileId) || !Number.isSafeInteger(entry.maxOutputTokens) || entry.maxOutputTokens < 1 || entry.maxOutputTokens > 10_000_000) throw new KernelError('invalid');
    profiles.set(dto.profileId, { dto: Object.freeze({ ...dto, authKinds: Object.freeze([...dto.authKinds]) as unknown as c.Profile['authKinds'],
      modelIds: Object.freeze([...dto.modelIds]) as unknown as string[] }), maxOutputTokens: entry.maxOutputTokens,
      ...(entry.limits === undefined ? {} : { limits: Object.freeze(parse(c.limits, entry.limits)) }) });
  }
  if (!profiles.size || profiles.size > 128) throw new KernelError('invalid');
  const withinProfile = (id: string, limits: ApprovedLimits): boolean => {
    const p = profiles.get(id);
    return !!p && limits.tokens <= p.maxOutputTokens && (!p.limits ||
      (Object.keys(p.limits) as (keyof ApprovedLimits)[]).every(k => limits[k] <= p.limits![k]));
  };
  const enrollment = options.enrollment && Object.freeze({ originRef: options.enrollment.originRef,
    engineIncarnation: options.enrollment.engineIncarnation, worker: options.enrollment.worker });
  if (enrollment) { identifier(enrollment.originRef); uuid(enrollment.engineIncarnation); uuid(enrollment.worker); }
  const transport = options.transport;
  const requireCurrent = (grant: Grant): void => {
    if (!bearers.current(grant) || (grant.role === 'execution' && Date.parse(grant.saved.admission.expiresAt) <= Date.now())) throw new KernelError('denied');
  };
  async function operationDTO(context: TrustedContext, op: OperationStatus): Promise<c.Operation> {
    if (op.state !== 'applied') return c.operation.parse({ operationRef: op.operationRef, state: op.state,
      ...(op.state === 'unknown' || op.state === 'rejected' ? { error: safe('upstream_failure', op.state === 'unknown' ? 'effect_unknown' : 'not_dispatched', { operationRef: op.operationRef }) } : {}) });
    // Persisted deadline marks preparation; close/fence acknowledgements have no
    // result variant. Readbacks use the original persisted account/epoch tuple.
    if (op.executionRef && op.deadline) {
      const saved = await kernel.savedExecution(context, op.executionRef);
      return c.preparationOperation.parse({ operationRef: op.operationRef, state: 'applied', result: {
        kind: 'execution', executionRef: op.executionRef, accountRef: saved.admission.accountRef,
        authorizationEpoch: saved.admission.authorizationEpoch, deadline: saved.admission.expiresAt, state: executionState(saved.state) } });
    }
    if (op.accountRef && !op.executionRef) {
      const a = await management.account(context, op.accountRef);
      return c.accountOperation.parse({ operationRef: op.operationRef, state: 'applied', result: { kind: 'account',
        accountRef: op.accountRef, metadataRevision: op.revision ?? a.revision, authorizationEpoch: op.epoch ?? a.epoch } });
    }
    return c.acknowledgementOperation.parse({ operationRef: op.operationRef, state: 'applied' });
  }
  function callback(context: TrustedContext, grant: Grant, saved: SavedExecution, requestId: string, signal: AbortSignal): NativeCallback {
    if (!enrollment) throw new KernelError('unavailable');
    const peer = enrollment;
    const validProof = (input: NativeDispatchProof): NativeDispatchProof => {
      const proof = { executionRef: input.executionRef, requestRef: input.requestRef, worker: input.worker, token: input.token,
        native: { originRef: input.native.originRef, engineIncarnation: input.native.engineIncarnation, requestNonce: input.native.requestNonce, generation: input.native.generation } };
      if (proof.executionRef !== saved.admission.executionRef || proof.requestRef !== requestId || proof.worker !== peer.worker ||
          proof.native.originRef !== peer.originRef || proof.native.engineIncarnation !== peer.engineIncarnation || proof.native.generation !== saved.generation) throw new KernelError('denied');
      return proof;
    };
    return Object.freeze({
      async admit(requestNonce: string): Promise<NativePermit> {
        uuid(requestNonce); requireCurrent(grant);
        if (signal.aborted) throw new KernelError('denied');
        const fresh = savedCopy(await kernel.savedExecution(context, saved.admission.executionRef));
        if (!sameSaved(saved, fresh)) throw new KernelError('denied');
        try {
          const previous = await kernel.request(context, fresh.admission.executionRef, requestId);
          return { claim: { status: previous } };
        } catch (error) {
          // Absence is only permission to continue to atomic claim, never a
          // non-entry receipt or permission to replay an earlier transport.
          if (!(error instanceof KernelError) || error.code !== 'unknown') throw error;
        }
        const mapping = await store.mapping(context, fresh.generation);
        if (!mapping || mapping.consumerId !== context.consumerId || mapping.accountRef !== fresh.admission.accountRef ||
            mapping.descriptor.profile !== fresh.admission.profileId || mapping.descriptor.generation !== fresh.generation ||
            mapping.descriptor.nativePhysicalIdentity !== fresh.generation) throw new KernelError('denied');
        const physical = physicalCandidate(mapping.descriptor);
        if (physical.model !== profiles.get(fresh.admission.profileId)?.dto.modelIds[0]) throw new KernelError('denied');
        await kernel.currentWorkerLease(context, peer.worker);
        requireCurrent(grant); if (signal.aborted) throw new KernelError('denied');
        const claim = await kernel.claim(context, fresh.admission.executionRef, requestId, peer.worker, fresh.admission,
          { originRef: peer.originRef, engineIncarnation: peer.engineIncarnation, requestNonce });
        if (!claim.dispatch) return { claim };
        try {
          const lease = await kernel.currentWorkerLease(context, peer.worker);
          requireCurrent(grant); if (signal.aborted) throw new KernelError('denied');
          if (claim.dispatch.descriptor.generation !== physical.generation || claim.dispatch.descriptor.nativePhysicalIdentity !== physical.nativePhysicalIdentity ||
              claim.dispatch.descriptor.profile !== physical.profile) throw new KernelError('denied');
          const expiry = Math.min(Date.parse(lease), Date.parse(claim.dispatch.deadline));
          if (expiry <= Date.now()) throw new KernelError('denied');
          return { claim, physical, permitExpiresAt: new Date(expiry).toISOString() };
        } catch {
          await kernel.effect(context, fresh.admission.executionRef, requestId, peer.worker, 'effect_unknown');
          throw new KernelError('unknown');
        }
      },
      effect: async (proof: NativeDispatchProof, next: 'response_started' | 'completed' | 'effect_unknown') => {
        const p = validProof(proof);
        const persisted = await kernel.requestProof(context, p.executionRef, p.requestRef);
        if (!persisted || p.token !== persisted.token || p.worker !== persisted.worker ||
            p.native.requestNonce !== persisted.native.requestNonce || p.native.originRef !== persisted.native.originRef ||
            p.native.engineIncarnation !== persisted.native.engineIncarnation || p.native.generation !== persisted.native.generation) throw new KernelError('denied');
        return kernel.effect(context, p.executionRef, p.requestRef, peer.worker, next);
      },
      rejectBeforeDispatch: (proof: NativeDispatchProof, entered: false) => kernel.rejectBeforeDispatch(context, peer.worker, validProof(proof), entered),
      closed: (proof: NativeDispatchProof, cleanup?: CleanupAuthority) => kernel.acknowledgeTransportClosed(context, peer.worker, validProof(proof), cleanup),
    });
  }
  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: Math.min(timeoutMs, 10_000), requestTimeout: timeoutMs,
    keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); res.destroy(); }, timeoutMs);
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected); res.once('finish', () => clearTimeout(timer)); res.once('close', () => clearTimeout(timer));
    req.setTimeout(timeoutMs, () => { controller.abort(); req.destroy(); }); res.setTimeout(timeoutMs, () => { controller.abort(); res.destroy(); });
    let enteredTransport = false, uncertain = false;
    let transportScope: { context: TrustedContext; ref: string; id: string } | undefined;
    const markUnknown = async (): Promise<void> => {
      if (transportScope && enrollment && enteredTransport) {
        await kernel.effect(transportScope.context, transportScope.ref, transportScope.id, enrollment.worker, 'effect_unknown').catch(() => undefined);
      }
    };
    controller.signal.addEventListener('abort', () => { void markUnknown(); }, { once: true });
    let identity: { operationRef?: string; requestRef?: string } = {};
    void (async () => {
      if (req.rawHeaders.length > 64) { res.shouldKeepAlive = false; send(res, c.safeError, safe('invalid_request', 'not_dispatched'), 400); return; }
      let authorization: string | undefined;
      try { authorization = singleton(req, 'authorization'); } catch { send(res, c.safeError, safe('unauthenticated', 'not_dispatched'), 401); return; }
      if (!authorization || !/^Bearer [A-Za-z0-9._~-]{16,1024}$/.test(authorization)) { send(res, c.safeError, safe('unauthenticated', 'not_dispatched'), 401); return; }
      const grant = bearers.resolve(authorization.slice(7));
      if (!grant) { send(res, c.safeError, safe('unauthenticated', 'not_dispatched'), 401); return; }
      requireCurrent(grant); const context = captureContext(grant);
      if (!req.url || req.url.length > 2048 || !/^\/(?:v1|internal\/v1)\//.test(req.url) || req.url.includes('#')) throw new KernelError('invalid');
      const url = new URL(req.url, 'http://facade.invalid');
      if (url.origin !== 'http://facade.invalid') throw new KernelError('invalid');
      const path = url.pathname, method = req.method;
      const streamRoute = req.method === 'POST' && /^\/v1\/executions\/[^/]+\/requests$/.test(path);
      if (singleton(req, 'content-type') !== 'application/json' ||
          singleton(req, 'accept') !== (streamRoute ? 'text/event-stream' : 'application/json')) throw new KernelError('invalid');
      const match = /^\/v1\/executions\/([A-Za-z0-9_-]+)(?:\/(requests)(?:\/([A-Za-z0-9_-]+))?|\/(close))?$/.exec(path);
      const opMatch = /^\/v1\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
      if (url.search && !(path === '/v1/accounts' && method === 'GET')) throw new KernelError('invalid');
      if (path === '/internal/v1/run-access') {
        if (grant.role !== 'run-control') throw new KernelError('denied');
        if (method !== 'POST' || req.url !== '/internal/v1/run-access') throw new KernelError('invalid');
        // Strict shared wire parsing captures independent immutable RR policy
        // before any authority/SQL await. No caller-supplied consumer or role.
        const parsed = parse(c.prepare, strictJSON(await body(req, Math.min(ingressBytes, 16_384)), true));
        const input = Object.freeze({ ...parsed, accountRefs: Object.freeze([...parsed.accountRefs]),
          limits: Object.freeze({ ...parsed.limits }) });
        identity = { operationRef: input.operationId };
        if (input.accountRefs.length > 16 || new Set(input.accountRefs).size !== input.accountRefs.length) throw new KernelError('invalid');
        input.accountRefs.forEach(uuid); identifier(input.profileId, 64);
        const profile = profiles.get(input.profileId);
        if (!grant.profileIds.includes(input.profileId) || !profile || !withinProfile(input.profileId, input.limits) ||
            input.limits.requestBytes > ingressBytes || input.limits.concurrency > input.limits.requests ||
            (Object.keys(grant.limits) as (keyof ApprovedLimits)[]).some(key => input.limits[key] > grant.limits[key])) throw new KernelError('denied');
        requireCurrent(grant);
        let old: OperationStatus | undefined;
        try { old = await kernel.operation(context, input.operationId); }
        catch (error) { if (!(error instanceof KernelError) || error.code !== 'unknown') throw error; }
        if (old && (!old.executionRef || !old.deadline)) throw new KernelError('conflict');
        const original = old && savedCopy(await kernel.savedExecution(context, old.executionRef!));
        // Ownership only: never derive original admission/epoch from Account GET.
        for (const ref of input.accountRefs) {
          const account = await management.account(context, ref);
          if (!grant.ownerRefs.includes(account.ownerRef) || account.profile !== input.profileId) throw new KernelError('denied');
        }
        if ((!original && Date.parse(input.deadline) <= Date.now()) ||
            Date.parse(input.deadline) - Date.now() > grant.maxRunMs) throw new KernelError('denied');
        const issuer = original?.admission.issuerEpoch ?? await kernel.issuer(context);
        requireCurrent(grant);
        const tuple = ['account-gateway/facade-prepare/v1', context.consumerId, input.invocationRef, input.attemptRef,
          [...input.accountRefs], input.profileId, input.subjectRef, input.policyRevision, input.bindingRevision, issuer, input.deadline,
          input.limits.requests, input.limits.concurrency, input.limits.requestBytes, input.limits.outputBytes, input.limits.tokens];
        uncertain = true;
        const op = await kernel.prepare(context, { operationId: input.operationId,
          intentDigest: createHmac('sha256', hmac).update(JSON.stringify(tuple)).digest('hex'),
          invocationRef: input.invocationRef, attemptRef: input.attemptRef, permittedAccounts: input.accountRefs, profile: input.profileId,
          policySubject: input.subjectRef, policyRevision: input.policyRevision, bindingRevision: input.bindingRevision,
          issuerEpoch: issuer, deadline: new Date(input.deadline), limits: input.limits });
        if (op.state !== 'applied' || !op.executionRef) throw new KernelError('unavailable');
        const saved = savedCopy(await kernel.savedExecution(context, op.executionRef));
        requireCurrent(grant);
        const bearer = bearers.upsertExecution(grant, saved);
        const { executionRef: _execution, issuerEpoch: _issuer, ...projection } = saved.admission;
        const result: RunAccess = { operation: c.preparationOperation.parse({ operationRef: op.operationRef, state: 'applied',
          result: { kind: 'execution', executionRef: saved.admission.executionRef, accountRef: saved.admission.accountRef,
            authorizationEpoch: saved.admission.authorizationEpoch, deadline: saved.admission.expiresAt, state: executionState(saved.state) } }),
          bearer, admission: c.admission.parse(projection) };
        send(res, { parse: (value: RunAccess) => value }, result); return;
      }
      if (grant.role === 'run-control') throw new KernelError('denied');
      if (grant.role === 'execution') {
        if (!match && !(opMatch && method === 'GET')) throw new KernelError('denied');
        if (match && match[1] !== grant.saved.admission.executionRef) throw new KernelError('denied');
      }
      if (opMatch && method === 'GET') {
        identity = { operationRef: parse(c.reference, opMatch[1]) }; uncertain = true;
        let op = await kernel.operation(context, identity.operationRef!);
        if (grant.role === 'execution' && op.executionRef !== grant.saved.admission.executionRef) throw new KernelError('denied');
        if (grant.role === 'management' && op.accountRef) {
          const account = await management.account(context, op.accountRef);
          if (!grant.ownerRefs.includes(account.ownerRef)) throw new KernelError('denied');
        }
        // Check the owner BEFORE touching protected native readback. Reconcile
        // only the original journal; the ordinary response has no capability.
        requireCurrent(grant);
        if (grant.role === 'management') op = await management.operation(context, identity.operationRef!);
        send(res, c.operation, await operationDTO(context, op)); return;
      }
      if (match) {
        const ref = parse(c.reference, match[1]);
        if (grant.role !== 'execution') throw new KernelError('denied');
        if (method === 'GET' && !match[2] && !match[4]) {
          const saved = await kernel.savedExecution(context, ref);
          send(res, c.execution, c.execution.parse({ executionRef: ref, accountRef: saved.admission.accountRef, authorizationEpoch: saved.admission.authorizationEpoch,
            profileId: saved.admission.profileId, deadline: saved.admission.expiresAt, state: executionState(saved.state) })); return;
        }
        if (method === 'GET' && match[3]) {
          identity = { requestRef: parse(c.reference, match[3]) }; uncertain = true;
          send(res, c.requestStatus, requestDTO(await kernel.request(context, ref, identity.requestRef!))); return;
        }
        if (method === 'POST' && match[4]) {
          const input = parse(c.close, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
          requireCurrent(grant); uncertain = true;
          send(res, c.acknowledgementOperation, await operationDTO(context, await kernel.close(context, input.operationId, ref))); return;
        }
        if (method !== 'POST' || !match[2] || match[3]) throw new KernelError('invalid');
        identity = { requestRef: parse(c.reference, singleton(req, 'x-gateway-request-id')) };
        const header = singleton(req, 'x-gateway-admission')!;
        if (Buffer.byteLength(header) > 4096) throw new KernelError('invalid');
        const admission = parse(c.admission, strictJSON(Buffer.from(header), true));
        const saved = savedCopy(await kernel.savedExecution(context, ref));
        const supplied = savedCopy({ ...saved, admission: { ...admission, executionRef: ref, issuerEpoch: grant.saved.admission.issuerEpoch } });
        if (!sameSaved(saved, grant.saved) || !sameSaved(saved, supplied) || !saved.dispatchAllowed) throw new KernelError('denied');
        const profile = profiles.get(saved.admission.profileId);
        if (!profile || !withinProfile(saved.admission.profileId, saved.admission.limits) || saved.admission.limits.requestBytes > ingressBytes) throw new KernelError('denied');
        const raw = await body(req, Math.min(ingressBytes, saved.admission.limits.requestBytes));
        parse(secretSubmission.nativeRequest, { requestId: identity.requestRef, admission, body: raw });
        validateResponses(raw, profile.dto.modelIds, profile.maxOutputTokens);
        requireCurrent(grant);
        if (!transport || !enrollment) throw new KernelError('unavailable');
        const abortAt = setTimeout(() => controller.abort(), Math.max(1, Date.parse(saved.admission.expiresAt) - Date.now()));
        const nativeCallback = callback(context, grant, saved, identity.requestRef!, controller.signal);
        transportScope = { context, ref, id: identity.requestRef! };
        enteredTransport = true; uncertain = true;
        try {
          const result = await transport.request({ context, saved, requestId: identity.requestRef!, body: raw, signal: controller.signal, callback: nativeCallback });
          if (result.kind === 'status') { send(res, c.requestStatus, requestDTO(await kernel.request(context, ref, identity.requestRef!)), 202); return; }
          let finished = false;
          const cancel = () => { void result.cancel().catch(() => undefined); };
          controller.signal.addEventListener('abort', cancel, { once: true });
          try {
            // Streaming data requires actual persisted callback claim, never an
            // injected response substituting for the kernel's authority.
            const status = await kernel.request(context, ref, identity.requestRef!);
            if (!['dispatch_started', 'response_started', 'completed'].includes(status.effect) || controller.signal.aborted) throw new KernelError('unknown');
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-gateway-request-ref': identity.requestRef!, 'cache-control': 'no-store' });
            res.flushHeaders();
            let output = 0;
            for await (const chunk of result.body) {
              output += chunk.byteLength;
              if (!(chunk instanceof Uint8Array) || chunk.byteLength > bufferBytes || output > saved.admission.limits.outputBytes || controller.signal.aborted) throw new KernelError('unknown');
              if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
            }
            const terminal = await kernel.request(context, ref, identity.requestRef!);
            if (terminal.effect !== 'completed' || controller.signal.aborted) throw new KernelError('unknown');
            finished = true; res.end();
          } finally {
            controller.signal.removeEventListener('abort', cancel);
            if (!finished) { controller.abort(); await result.cancel().catch(() => undefined); }
          }
        } finally { clearTimeout(abortAt); }
        return;
      }
      if (grant.role !== 'management') throw new KernelError('denied');
      if (path === '/v1/profiles' && method === 'GET') { send(res, c.profiles, { profiles: [...profiles.values()].map(p => p.dto) }); return; }
      if (path === '/v1/accounts' && method === 'GET') {
        const query = new Map<string, unknown>();
        for (const [key, value] of url.searchParams) {
          if (query.has(key)) throw new KernelError('invalid');
          query.set(key, key === 'limit' && /^[1-9]\d*$/.test(value) ? Number(value) : value);
        }
        // Own data properties preserve unknown names such as __proto__ for the
        // SDK strict schema; ordinary assignment could silently erase them.
        const input = parse(c.listQuery, Object.fromEntries(query));
        if (input.ownerRef && !grant.ownerRefs.includes(input.ownerRef)) throw new KernelError('denied');
        const page = await management.accounts(context, { ...input, allowedOwnerRefs: grant.ownerRefs });
        send(res, c.accounts, { accounts: page.accounts.map(accountDTO), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }); return;
      }
      if (path === '/v1/accounts/oauth/begin' && method === 'POST') {
        const parsed = parse(c.oauthBegin, strictJSON(await body(req, Math.min(ingressBytes, 16_384)), true));
        const input = Object.freeze({ ...parsed }); identity = { operationRef: input.operationId };
        const profile = profiles.get(input.profileId);
        if (!grant.ownerRefs.includes(input.ownerRef) || grant.preparation.profileId !== input.profileId || !profile || profile.dto.authKinds[0] !== 'oauth' ||
            !management.supportsOAuthProfile(input.profileId)) throw new KernelError('denied');
        requireCurrent(grant); uncertain = true;
        const result = await management.beginOAuth(context, { operationId: input.operationId, ownerRef: input.ownerRef,
          profile: input.profileId, displayName: input.displayName });
        // A retired management grant never receives a newly returned owner URL.
        requireCurrent(grant);
        send(res, c.oauthBeginResponse, { operation: await operationDTO(context, result.operation),
          ...(result.authorizationURL === undefined ? {} : { authorizationURL: result.authorizationURL }) },
          result.operation.state === 'pending' ? 202 : 200); return;
      }
      if (path === '/v1/accounts' && method === 'POST') {
        const input = parse(secretSubmission.connect, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
        if (!grant.ownerRefs.includes(input.ownerRef) || profiles.get(input.profileId)?.dto.authKinds[0] !== 'api_key') throw new KernelError('denied');
        if (input.credential.kind !== 'api_key') throw new KernelError('invalid');
        requireCurrent(grant); uncertain = true;
        const op = await management.create(context, { operationId: input.operationId, ownerRef: input.ownerRef,
          profile: input.profileId, displayName: input.displayName, apiKey: input.credential.value });
        send(res, c.accountOperation, await operationDTO(context, op), op.state === 'pending' ? 202 : 200); return;
      }
      const accountMatch = /^\/v1\/accounts\/([A-Za-z0-9_-]+)(?:\/(reconnect|disable))?$/.exec(path);
      if (accountMatch) {
        const ref = parse(c.reference, accountMatch[1]);
        const account = await management.account(context, ref);
        if (!grant.ownerRefs.includes(account.ownerRef)) throw new KernelError('denied');
        if (method === 'GET' && !accountMatch[2]) { send(res, c.account, accountDTO(account)); return; }
        if (method === 'PATCH' && !accountMatch[2]) {
          const input = parse(c.rename, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
          requireCurrent(grant); uncertain = true;
          send(res, c.accountOperation, await operationDTO(context, await management.rename(context, { operationId: input.operationId,
            accountRef: ref, expectedRevision: input.expectedMetadataRevision, displayName: input.displayName }))); return;
        }
        if (method === 'POST' && accountMatch[2] === 'disable') {
          const input = parse(c.disable, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
          requireCurrent(grant); uncertain = true;
          send(res, c.accountOperation, await operationDTO(context, await management.disable(context, { operationId: input.operationId,
            accountRef: ref, expectedRevision: input.expectedMetadataRevision }))); return;
        }
        if (method === 'POST' && accountMatch[2] === 'reconnect') {
          if (profiles.get(account.profile)?.dto.authKinds[0] !== 'api_key') throw new KernelError('denied');
          const input = parse(secretSubmission.reconnect, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
          if (input.credential.kind !== 'api_key') throw new KernelError('invalid');
          requireCurrent(grant); uncertain = true;
          send(res, c.accountOperation, await operationDTO(context, await management.reconnect(context, { operationId: input.operationId,
            accountRef: ref, expectedRevision: input.expectedMetadataRevision, apiKey: input.credential.value }))); return;
        }
        throw new KernelError('invalid');
      }
      if (path === '/v1/executions' && method === 'POST') {
        const input = parse(c.prepare, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
        const p = grant.preparation;
        if (input.subjectRef !== p.subjectRef || input.policyRevision !== p.policyRevision || input.bindingRevision !== p.bindingRevision ||
            input.profileId !== p.profileId || !withinProfile(p.profileId, input.limits) ||
            input.limits.requestBytes > ingressBytes || input.accountRefs.some(ref => !p.accountRefs.includes(ref)) ||
            new Set(input.accountRefs).size !== input.accountRefs.length || input.limits.concurrency > input.limits.requests || Date.parse(input.deadline) <= Date.now() ||
            Date.parse(input.deadline) - Date.now() > p.maxRunMs ||
            (Object.keys(p.limits) as (keyof ApprovedLimits)[]).some(key => input.limits[key] > p.limits[key])) throw new KernelError('denied');
        for (const ref of input.accountRefs) {
          const a = await management.account(context, ref);
          if (!grant.ownerRefs.includes(a.ownerRef) || a.profile !== p.profileId) throw new KernelError('denied');
        }
        const issuer = await kernel.issuer(context); requireCurrent(grant);
        const tuple = ['account-gateway/facade-prepare/v1', context.consumerId, input.invocationRef, input.attemptRef,
          [...input.accountRefs], p.profileId, p.subjectRef, p.policyRevision, p.bindingRevision, issuer, input.deadline,
          input.limits.requests, input.limits.concurrency, input.limits.requestBytes, input.limits.outputBytes, input.limits.tokens];
        uncertain = true;
        const op = await kernel.prepare(context, { operationId: input.operationId, intentDigest: createHmac('sha256', hmac).update(JSON.stringify(tuple)).digest('hex'),
          invocationRef: input.invocationRef, attemptRef: input.attemptRef, permittedAccounts: input.accountRefs, profile: p.profileId,
          policySubject: p.subjectRef, policyRevision: p.policyRevision, bindingRevision: p.bindingRevision, issuerEpoch: issuer,
          deadline: new Date(input.deadline), limits: input.limits });
        send(res, c.preparationOperation, await operationDTO(context, op)); return;
      }
      if (path === '/v1/policy-fences' && method === 'POST') {
        const input = parse(c.fence, strictJSON(await body(req, ingressBytes), true)); identity = { operationRef: input.operationId };
        if (input.subjectRef !== grant.preparation.subjectRef || input.revision < grant.preparation.policyRevision) throw new KernelError('denied');
        requireCurrent(grant); uncertain = true;
        send(res, c.acknowledgementOperation, await operationDTO(context, await kernel.fence(context, input.operationId, input.subjectRef, input.revision))); return;
      }
      throw new KernelError('invalid');
    })().catch(async error => {
      await markUnknown();
      if (res.headersSent || res.destroyed) { controller.abort(); res.destroy(); return; }
      const code = error instanceof KernelError ? error.code : 'unavailable';
      const dtoCode: c.SafeError['code'] = code === 'invalid' ? 'invalid_request' : code === 'denied' ? 'forbidden' : code === 'conflict' ? 'conflict' : code === 'unknown' ? 'not_found' : 'upstream_failure';
      // No absence readback or transport exception is a non-entry receipt.
      res.shouldKeepAlive = false;
      send(res, c.safeError, safe(dtoCode, enteredTransport || uncertain ? 'effect_unknown' : 'not_dispatched', identity),
        code === 'denied' ? 403 : code === 'invalid' ? 400 : code === 'conflict' ? 409 : code === 'unknown' ? 404 : 503);
    });
  });
  // Inspect the entire byte-bounded raw header set before applying the count
  // limit; Node's truncation must never hide a second Authorization field.
  server.maxHeadersCount = 0; server.maxConnections = 128;
  server.on('clientError', (_error, socket) => {
    const bytes = JSON.stringify(safe('invalid_request', 'not_dispatched'));
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(bytes) + '\r\n\r\n' + bytes);
  });
  return server;
}
