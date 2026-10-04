import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { identifier } from './domain.ts';
import type { DurableKernel, ExecutionRead, NativeDispatchProof, SavedExecution, TrustedContext } from './domain.ts';
import type { NativeCallback, NativeTransport } from './facade.ts';
import type { ManagementStore } from './management.ts';
import { physicalCandidate } from './management.ts';
import { validateResponses } from './facade-ingress.ts';
import { admission, binding, cleanup, config, denied, descriptor, instant, jsonBody, now, object,
  physicallyClosed, proof, receipt, sameAdmission, sameDescriptor, sameProof, saved, singleton } from './native-wire.ts';
import type { BridgeConfig, Configuration, Descriptor } from './native-wire.ts';

type Input = Parameters<NativeTransport['request']>[0];
export interface Association {
  readonly context: TrustedContext; readonly saved: SavedExecution; readonly requestId: string;
  readonly callback: NativeCallback; readonly digest: string; readonly signal: AbortSignal;
  descriptor?: Readonly<Descriptor>; native?: NativeDispatchProof['native']; proof?: NativeDispatchProof;
  ready: boolean; admitStarted: boolean; outboundStarted: boolean; acknowledged: boolean;
  ackStarted?: boolean; closeRef?: string;
}
export interface AuthorityOptions { readonly config: BridgeConfig; readonly kernel: DurableKernel & ExecutionRead;
  readonly store: Pick<ManagementStore, 'mapping'> }
const hash = (s: string) => createHash('sha256').update(s).digest();
const key = (ctx: TrustedContext, ref: string, id: string) => JSON.stringify([ctx.consumerId, ref, id]);

// Routing associations are bounded volatile capabilities. SQL remains the only
// claim/effect/occupancy authority, including after this process disappears.
export class NativeAuthority {
  readonly configuration: Configuration;
  readonly kernel: DurableKernel & ExecutionRead;
  readonly #store: Pick<ManagementStore, 'mapping'>;
  readonly #pending = new Map<string, Association>();
  readonly #callers: readonly { hash: Buffer; consumerId: string }[];
  constructor(options: AuthorityOptions) {
    this.configuration = config(options.config); this.kernel = options.kernel; this.#store = options.store;
    this.#callers = this.configuration.consumers.map(c => ({ hash: hash(c.callbackCredential), consumerId: c.consumerId }));
  }
  consumer(ctx: TrustedContext) {
    const c = this.configuration.consumers.find(c => c.consumerId === ctx.consumerId);
    if (!c) return denied(); return c;
  }
  begin(input: Input, bytes: Uint8Array): { association: Association; first: boolean } {
    const context = Object.freeze({ consumerId: input.context.consumerId }); identifier(context.consumerId); this.consumer(context);
    const snapshot = saved(input.saved); identifier(input.requestId);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const index = key(context, snapshot.admission.executionRef, input.requestId), previous = this.#pending.get(index);
    if (previous) {
      if (!sameAdmission(previous.saved.admission, snapshot.admission) || previous.saved.generation !== snapshot.generation || previous.digest !== digest) return denied();
      return { association: previous, first: false };
    }
    if (this.#pending.size >= this.configuration.maxPending) {
      // Eviction follows protected durable closure ACK only, never local expiry.
      for (const [k, a] of this.#pending) if (a.acknowledged) { this.#pending.delete(k); break; }
    }
    if (this.#pending.size >= this.configuration.maxPending) return denied();
    // Capture callable methods rather than a mutable callback container.
    const callback = Object.freeze({ admit: input.callback.admit.bind(input.callback), effect: input.callback.effect.bind(input.callback),
      rejectBeforeDispatch: input.callback.rejectBeforeDispatch.bind(input.callback), closed: input.callback.closed.bind(input.callback) });
    const a: Association = { context, saved: snapshot, requestId: input.requestId, digest, callback, signal: input.signal,
      ready: false, admitStarted: false, outboundStarted: false, acknowledged: false };
    this.#pending.set(index, a); return { association: a, first: true };
  }
  async prepare(a: Association, bytes: Uint8Array): Promise<void> {
    const fresh = saved(await this.kernel.savedExecution(a.context, a.saved.admission.executionRef));
    if (!sameAdmission(fresh.admission, a.saved.admission) || fresh.generation !== a.saved.generation ||
        !fresh.dispatchAllowed || fresh.state !== 'open' || a.signal.aborted || instant(fresh.admission.expiresAt) <= now()) return denied();
    const mapping = await this.#store.mapping(a.context, fresh.generation);
    if (!mapping || mapping.consumerId !== a.context.consumerId || mapping.accountRef !== fresh.admission.accountRef ||
        mapping.generation !== fresh.generation) return denied();
    const physical = physicalCandidate(mapping.descriptor), d = descriptor(physical);
    const profile = this.configuration.profiles.find(p => p.profile === fresh.admission.profileId);
    if (!profile || mapping.profile.qualificationRef !== profile.qualificationRef || physical.nativePhysicalIdentity !== fresh.generation ||
        d.generation !== fresh.generation || d.profile !== profile.profile || d.base_url !== profile.baseURL || d.model !== profile.model ||
        fresh.admission.limits.requestBytes > profile.requestBytes || fresh.admission.limits.outputBytes > profile.outputBytes ||
        fresh.admission.limits.tokens > profile.tokens || bytes.byteLength > fresh.admission.limits.requestBytes) return denied();
    instant(d.created_at); validateResponses(bytes, [profile.model], profile.providerTokenUpperBound);
    await this.kernel.currentWorkerLease(a.context, this.configuration.enrollment.worker);
    if (a.signal.aborted) return denied();
    a.descriptor = d; a.ready = true;
  }
  async persisted(ctx: TrustedContext, p: NativeDispatchProof): Promise<void> {
    this.consumer(ctx);
    const e = this.configuration.enrollment;
    if (p.worker !== e.worker || p.native.originRef !== e.originRef || p.native.engineIncarnation !== e.engineIncarnation) return denied();
    const actual = await this.kernel.requestProof(ctx, p.executionRef, p.requestRef);
    if (!actual || !sameProof(proof(actual), p)) return denied();
    // Original proofs remain valid for closure after deadline/lease/fence loss.
  }
  async dispatch(ctx: TrustedContext, p: NativeDispatchProof, expires: unknown): Promise<void> {
    const requested = instant(expires);
    await this.persisted(ctx, p);
    const execution = saved(await this.kernel.savedExecution(ctx, p.executionRef));
    const lease = instant(await this.kernel.currentWorkerLease(ctx, p.worker));
    const status = await this.kernel.request(ctx, p.executionRef, p.requestRef);
    if (!execution.dispatchAllowed || execution.state !== 'open' || execution.generation !== p.native.generation ||
        !['dispatch_started','response_started'].includes(status.effect) || requested <= now() || requested > lease ||
        requested > instant(execution.admission.expiresAt)) return denied();
  }
  async delegated(ctx: TrustedContext, p: NativeDispatchProof, value: unknown): Promise<ReturnType<typeof cleanup>> {
    const c = cleanup(value); await this.persisted(ctx, p);
    const actual = instant(await this.kernel.currentCleanupLease(ctx, c.cleanupRef, c.worker, c.token));
    if (instant(c.leaseExpiresAt) !== actual || actual <= now()) return denied();
    const scoped = await this.kernel.cleanupTransports(ctx, c.cleanupRef, c.worker, c.token);
    if (actual <= now() || !scoped.some(s => s.token && s.native && sameProof(proof(s), p))) return denied();
    return c;
  }
  async #admit(ctx: TrustedContext, value: unknown): Promise<unknown> {
    const r = object(value, ['consumerId','requestRef','worker','admission','descriptor','native']);
    const admitted = admission(r.admission), native = binding(r.native), e = this.configuration.enrollment;
    identifier(r.requestRef);
    const a = this.#pending.get(key(ctx, admitted.executionRef, r.requestRef));
    if (!a || !a.ready || !a.outboundStarted || !a.descriptor || r.worker !== e.worker ||
        native.originRef !== e.originRef || native.engineIncarnation !== e.engineIncarnation || native.generation !== a.saved.generation ||
        !sameAdmission(admitted, a.saved.admission) || !sameDescriptor(r.descriptor, a.descriptor) || a.signal.aborted ||
        a.native && !sameProof({ executionRef: admitted.executionRef, requestRef: a.requestId, worker: e.worker, token: 'comparison', native },
          { executionRef: admitted.executionRef, requestRef: a.requestId, worker: e.worker, token: 'comparison', native: a.native })) return denied();
    if (a.admitStarted) {
      const status = await this.kernel.request(ctx, admitted.executionRef, a.requestId);
      return { consumerId: ctx.consumerId, admission: a.saved.admission, status };
    }
    a.native = native; a.admitStarted = true; // Before the sole captured claim await.
    const permit = await a.callback.admit(native.requestNonce);
    if (!permit.claim.dispatch) return { consumerId: ctx.consumerId, admission: a.saved.admission, status: permit.claim.status };
    const d = permit.claim.dispatch, p = proof(d.closure);
    a.proof = p; // Keep the original proof even if subsequent ACK validation fails.
    if (!permit.physical || !permit.permitExpiresAt || permit.claim.status.effect !== 'dispatch_started' ||
        permit.claim.status.requestRef !== a.requestId || d.executionRef !== admitted.executionRef || d.requestRef !== a.requestId ||
        !sameAdmission({ ...admitted, limits: d.limits, expiresAt: d.deadline }, admitted) ||
        d.descriptor.generation !== a.saved.generation || d.descriptor.nativePhysicalIdentity !== a.saved.generation ||
        d.descriptor.profile !== admitted.profileId || !sameDescriptor(descriptor(physicalCandidate(permit.physical)), a.descriptor) ||
        p.requestRef !== a.requestId || p.executionRef !== admitted.executionRef || p.worker !== e.worker ||
        !sameProof({ ...p, native }, p)) return denied();
    await this.dispatch(ctx, p, permit.permitExpiresAt);
    return { consumerId: ctx.consumerId, admission: a.saved.admission, status: permit.claim.status,
      dispatch: d, nativeDescriptor: a.descriptor, leaseExpiresAt: permit.permitExpiresAt };
  }
  createServer(): Server {
    const cfg = this.configuration;
    const server = createServer({ maxHeaderSize: 16_384, headersTimeout: cfg.timeoutMs, requestTimeout: cfg.timeoutMs,
      keepAliveTimeout: 1000, connectionsCheckingInterval: 100 }, (req, res) => {
      const timer = setTimeout(() => { req.destroy(); res.destroy(); }, cfg.timeoutMs);
      res.once('close', () => clearTimeout(timer)); res.once('finish', () => clearTimeout(timer));
      const send = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(body)); } };
      void (async () => {
        if (req.method !== 'POST' || !req.url || !/^\/private\/native\/v1\/(enrollment|admit|dispatch-proof|cleanup-authority|owner-closure-authority|closure-ack)$/.test(req.url) ||
            req.rawHeaders.length > 64 || singleton(req, 'content-type') !== 'application/json' ||
            req.rawHeaders.some((h, i) => i % 2 === 0 && ['content-encoding','transfer-encoding'].includes(h.toLowerCase()))) return denied();
        const authorization = singleton(req, 'authorization');
        if (!authorization || authorization.length > 1031 || !/^Bearer [A-Za-z0-9._~+/-]{16,1024}=*$/.test(authorization)) return denied();
        const h = hash(authorization.slice(7)), caller = this.#callers.find(c => timingSafeEqual(c.hash, h));
        if (!caller) return denied();
        const ctx = Object.freeze({ consumerId: caller.consumerId }), body = await jsonBody(req, cfg.controlBytes);
        if (req.url.endsWith('/enrollment')) {
          const r = object(body, ['originRef','engineIncarnation','qualificationRef']), e = cfg.enrollment;
          if (r.originRef !== e.originRef || r.engineIncarnation !== e.engineIncarnation || r.qualificationRef !== e.qualificationRef) return denied();
        } else if (req.url.endsWith('/admit')) {
          const r = object(body, ['consumerId','requestRef','worker','admission','descriptor','native']);
          if (r.consumerId !== ctx.consumerId) return denied();
          send(200, await this.#admit(ctx, r)); return;
        } else {
          const route = req.url.slice(req.url.lastIndexOf('/') + 1);
          const r = object(body, ['consumerId','proof', ...(route === 'dispatch-proof' ? ['leaseExpiresAt'] :
            route === 'cleanup-authority' ? ['cleanup'] : route === 'closure-ack' ? ['receipt'] : [])], route === 'closure-ack' ? ['cleanup'] : []);
          if (r.consumerId !== ctx.consumerId) return denied();
          const p = proof(r.proof);
          if (route === 'dispatch-proof') await this.dispatch(ctx, p, r.leaseExpiresAt);
          else if (route === 'cleanup-authority') await this.delegated(ctx, p, r.cleanup);
          else {
            await this.persisted(ctx, p);
            if (route === 'closure-ack') {
              const closed = receipt(r.receipt, ctx.consumerId, p);
              if (!physicallyClosed(closed)) return denied();
              const c = r.cleanup === undefined ? undefined : await this.delegated(ctx, p, r.cleanup);
              await this.kernel.acknowledgeTransportClosed(ctx, c?.worker ?? p.worker, p,
                c && { cleanupRef: c.cleanupRef, token: c.token });
              const a = this.#pending.get(key(ctx, p.executionRef, p.requestRef));
              if (a && a.proof && sameProof(a.proof, p)) a.acknowledged = true;
            }
          }
        }
        send(200, { ok: true });
      })().catch(() => send(403, { code: 'denied' }));
    });
    // Trusted composition may choose a port, never a public bind address.
    server.maxConnections = cfg.maxPending; server.maxRequestsPerSocket = 1;
    server.on('listening', () => { const a = server.address(); if (!a || typeof a === 'string' || !['127.0.0.1','::1'].includes(a.address)) server.close(); });
    server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    return server;
  }
}
