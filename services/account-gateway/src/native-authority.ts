import type { UsageJournal } from './usage.ts';
import * as c from '@agent-teams/account-gateway/contracts';
import { oauthProfileDefinition } from './oauth-profiles.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { KernelError, approvedLimits, defaults, identifier, uuid } from './domain.ts';
import type { ApprovedLimits, DurableKernel, ExecutionRead, NativeDispatchProof, RequestStatus, SavedExecution, TrustedContext } from './domain.ts';
import type { FacadeBearers, NativeCallback, NativeTransport } from './facade.ts';
import type { ManagementStore, CandidateJournal } from './management.ts';
import { accountLimitsTarget, exactCandidate, physicalCandidate } from './management.ts';
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
  readonly store: Pick<ManagementStore, 'mapping'>;
  readonly executionBearers?: FacadeBearers; readonly usage?: UsageJournal;
  readonly profileLimits?: readonly { readonly profile: string; readonly limits: Readonly<ApprovedLimits> }[];
  readonly oauthOwners?: { readonly store: Pick<ManagementStore, 'readJournal' | 'pendingOAuthRefresh'>;
    readonly bearers: Pick<FacadeBearers, 'authorizesOwner'> };
  readonly oauthRefreshOwners?: { readonly store: Pick<ManagementStore, 'readJournal' | 'activeOAuthRefresh' | 'pendingOAuthRefresh'>;
    readonly bearers: Pick<FacadeBearers, 'authorizesOwner'> };
  readonly accountLimitsOwners?: { readonly bearers: Pick<FacadeBearers, 'authorizesAccountLimits'> };
  readonly oauthCleanupOwners?: { readonly store: Pick<ManagementStore, 'readJournal' | 'oauthCleanup'> } }
const hash = (s: string) => createHash('sha256').update(s).digest();
const key = (ctx: TrustedContext, ref: string, id: string) => JSON.stringify([ctx.consumerId, ref, id]);

// Routing associations are bounded volatile capabilities. SQL remains the only
// claim/effect/occupancy authority, including after this process disappears.
export class NativeAuthority {
  readonly configuration: Configuration;
  readonly kernel: DurableKernel & ExecutionRead;
  readonly #executionBearers?: FacadeBearers;
  readonly #usage?: UsageJournal;
  readonly #store: Pick<ManagementStore, 'mapping'>;
  readonly #owners: AuthorityOptions['oauthOwners'];
  readonly #accountLimitsOwners: AuthorityOptions['accountLimitsOwners'];
  readonly #refreshOwners: AuthorityOptions['oauthRefreshOwners'];
  readonly #cleanupOwners: AuthorityOptions['oauthCleanupOwners'];
  readonly #limits = new Map<string, Readonly<ApprovedLimits>>();
  readonly #pending = new Map<string, Association>();
  readonly #callers: readonly { hash: Buffer; consumerId: string }[];
  constructor(options: AuthorityOptions) {
    // The legacy wire validator couples its single enrollment receipt to every
    // profile. Validate each tuple with its own receipt, retaining the original
    // enrollment ACK receipt and all shared transport/control bounds.
    const base = config({ ...options.config, profiles: options.config.profiles.slice(0, 1) });
    if (options.config.profiles.length > 4) denied();
    const profiles = options.config.profiles.map(p => config({ ...options.config,
      enrollment: { ...options.config.enrollment, qualificationRef: p.qualificationRef }, profiles: [p] }).profiles[0]);
    if (new Set(profiles.map(p => p.profile)).size !== profiles.length) denied();
    this.configuration = Object.freeze({ ...base, profiles: Object.freeze(profiles) });
    if (options.profileLimits) {
      if (options.profileLimits.length !== profiles.length) denied();
      for (const entry of options.profileLimits) {
        const p = profiles.find(p => p.profile === entry.profile);
        const limits = Object.freeze(approvedLimits(entry.limits, { ...defaults, maxConcurrent: 64 }));
        if (!p || this.#limits.has(entry.profile) || limits.requestBytes !== p.requestBytes ||
            limits.outputBytes !== p.outputBytes || limits.tokens !== p.tokens) denied();
        this.#limits.set(entry.profile, limits);
      }
    }
    this.#executionBearers = options.executionBearers; this.#usage = options.usage;
    this.kernel = options.kernel; this.#store = options.store; this.#owners = options.oauthOwners;
    this.#accountLimitsOwners = options.accountLimitsOwners;
    this.#refreshOwners = options.oauthRefreshOwners;
    this.#cleanupOwners = options.oauthCleanupOwners;
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
      // Retained claims are evicted only after protected durable closure ACK.
      for (const [k, a] of this.#pending) if (a.acknowledged) { this.#pending.delete(k); break; }
    }
    if (this.#pending.size >= this.configuration.maxPending) return denied();
    // Capture callable methods rather than a mutable callback container.
    const callback = Object.freeze({ ...(input.callback.usage ? {usage: input.callback.usage.bind(input.callback)} : {}), admit: input.callback.admit.bind(input.callback), effect: input.callback.effect.bind(input.callback),
      rejectBeforeDispatch: input.callback.rejectBeforeDispatch.bind(input.callback), closed: input.callback.closed.bind(input.callback) });
    const a: Association = { context, saved: snapshot, requestId: input.requestId, digest, callback, signal: input.signal,
      ready: false, admitStarted: false, outboundStarted: false, acknowledged: false };
    this.#pending.set(index, a); return { association: a, first: true };
  }
  #forget(a: Association): void {
    const index = key(a.context, a.saved.admission.executionRef, a.requestId);
    if (this.#pending.get(index) === a) this.#pending.delete(index);
  }
  reclaimUnstarted(a: Association): void {
    // Only the synchronous pre-POST path can establish this positive fact.
    if (!a.outboundStarted && !a.admitStarted) this.#forget(a);
  }
  async reclaimDenied(a: Association): Promise<void> {
    if (!a.admitStarted || a.proof) return denied();
    const ref = a.saved.admission.executionRef;
    const status = await this.kernel.request(a.context, ref, a.requestId);
    if (status.effect !== 'not_dispatched' || status.requestRef !== a.requestId ||
        await this.kernel.requestProof(a.context, ref, a.requestId)) return denied();
    // SQL retains the denial/replay tombstone; this map only routes callbacks.
    this.#forget(a);
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
    const limits = this.#limits.get(fresh.admission.profileId);
    if (!profile || mapping.profile.profile !== profile.profile || mapping.profile.baseURL !== profile.baseURL ||
        mapping.profile.model !== profile.model || mapping.profile.qualificationRef !== profile.qualificationRef || physical.nativePhysicalIdentity !== fresh.generation ||
        d.generation !== fresh.generation || d.profile !== profile.profile || d.base_url !== profile.baseURL || d.model !== profile.model ||
        fresh.admission.limits.requestBytes > profile.requestBytes || fresh.admission.limits.outputBytes > profile.outputBytes ||
        fresh.admission.limits.tokens > profile.tokens || bytes.byteLength > fresh.admission.limits.requestBytes ||
        limits && (Object.keys(limits) as (keyof ApprovedLimits)[]).some(k => fresh.admission.limits[k] > limits[k])) return denied();
    instant(d.created_at); validateResponses(bytes, [profile.model], profile.providerTokenUpperBound);
    await this.kernel.currentWorkerLease(a.context, this.configuration.enrollment.worker);
    if (a.signal.aborted) return denied();
    a.descriptor = d; a.ready = true;
  }
  // Resolve the original source-owned tuple from durable custody, never from
  // caller-selected provider fields or the ordering of configured profiles.
  #oauthProfile(journal: CandidateJournal | undefined, cleanupOnly = false) {
    if (!journal) return undefined;
    const definition = oauthProfileDefinition(journal.profile.profile);
    const profile = this.configuration.profiles.find(p => p.profile === journal.profile.profile);
    if (!definition || !profile || profile.baseURL !== definition.baseURL || profile.model !== definition.model ||
        journal.profile.baseURL !== profile.baseURL || journal.profile.qualificationRef !== profile.qualificationRef ||
        (cleanupOnly ? !definition.cleanupModels.includes(journal.profile.model) : journal.profile.model !== profile.model)) return undefined;
    return profile;
  }
  // Cached reads have separate consumer authority and permit suspended custody.
  async #accountLimitsOwner(ctx: TrustedContext, value: unknown): Promise<unknown> {
    const r = object(value, ['consumerId','ownerRef','accountRef','profileId','expectedAuthorizationEpoch']);
    if (r.consumerId !== ctx.consumerId || !this.#accountLimitsOwners || typeof r.profileId !== 'string' || !oauthProfileDefinition(r.profileId) ||
        !this.#accountLimitsOwners.bearers.authorizesAccountLimits(ctx, r.ownerRef as string, r.profileId)) return denied();
    const target = await accountLimitsTarget(this.kernel, this.#store, ctx, {
      ownerRef: r.ownerRef as string, accountRef: r.accountRef as string, profileId: r.profileId,
      expectedAuthorizationEpoch: r.expectedAuthorizationEpoch as number,
    });
    if (!this.#accountLimitsOwners.bearers.authorizesAccountLimits(ctx, r.ownerRef as string, r.profileId)) return denied();
    return { ok: true, native: descriptor(target) };
  }
  // Enrollment and refresh keep their existing authority and reject suspended.
  async #custodyOwner(ctx: TrustedContext, value: unknown): Promise<{ ok: true; ownerRef: string }> {
    const r = object(value, ['consumerId','operationId','accountRef','generation']);
    if (!this.#owners || !this.kernel.accountCustody || r.consumerId !== ctx.consumerId) return denied();
    identifier(r.operationId); uuid(r.accountRef); uuid(r.generation);
    const j = await this.#owners.store.readJournal(ctx, r.operationId);
    const p = this.#oauthProfile(j);
    if (!j || !p || j.consumerId !== ctx.consumerId || j.operationId !== r.operationId ||
        j.accountRef !== r.accountRef || j.generation !== r.generation || !['create','reconnect'].includes(j.purpose) ||
        j.profile.profile !== p.profile || j.profile.baseURL !== p.baseURL || j.profile.model !== p.model ||
        j.profile.qualificationRef !== p.qualificationRef) return denied();
    const op = await this.kernel.operation(ctx, j.operationId);
    const account = await this.kernel.account(ctx, j.accountRef);
    const mapping = await this.#store.mapping(ctx, j.generation);
    if (op.state !== 'applied' || op.accountRef !== j.accountRef || account.state !== 'suspended' ||
        account.ownerRef !== j.ownerRef || account.profile !== j.profile.profile || !mapping ||
        mapping.operationId !== j.operationId || mapping.consumerId !== ctx.consumerId ||
        mapping.accountRef !== j.accountRef || mapping.ownerRef !== j.ownerRef ||
        mapping.purpose !== j.purpose || mapping.profile.qualificationRef !== j.profile.qualificationRef ||
        mapping.generation !== j.generation || !exactCandidate(j, physicalCandidate(mapping.descriptor))) return denied();
    const current = await this.kernel.accountCustody(ctx, j.accountRef);
    if (current.generation !== j.generation || current.nativePhysicalIdentity !== mapping.descriptor.nativePhysicalIdentity ||
        !this.#owners.bearers.authorizesOwner(ctx, j.ownerRef, j.profile.profile)) return denied();
    return { ok: true, ownerRef: j.ownerRef };
  }
  async #owner(ctx: TrustedContext, value: unknown): Promise<{ ok: true; ownerRef: string }> {
    const r = object(value, ['consumerId','operationId','accountRef','generation']);
    if (!this.#owners || r.consumerId !== ctx.consumerId) return denied();
    identifier(r.operationId); uuid(r.accountRef); uuid(r.generation);
    const j = await this.#owners.store.readJournal(ctx, r.operationId);
    const p = this.#oauthProfile(j);
    if (!j || !p || j.consumerId !== ctx.consumerId || j.operationId !== r.operationId ||
        j.accountRef !== r.accountRef || j.generation !== r.generation || !['create','reconnect'].includes(j.purpose) ||
        j.profile.profile !== p.profile || j.profile.baseURL !== p.baseURL ||
        j.profile.model !== p.model || j.profile.qualificationRef !== p.qualificationRef) return denied();
    identifier(j.ownerRef);
    const op = await this.kernel.operation(ctx, j.operationId);
    const account = await this.kernel.account(ctx, j.accountRef);
    if (op.operationRef !== j.operationId || op.accountRef !== j.accountRef || !['pending','applied'].includes(op.state) ||
        account.accountRef !== j.accountRef || account.ownerRef !== j.ownerRef || account.profile !== j.profile.profile ||
        (!['staging','active','quarantined'].includes(account.state) &&
          !(account.state === 'disabled' && op.state === 'pending' && j.purpose === 'reconnect'))) return denied();
    if (op.state === 'pending') {
      // Disabled authorizes only the exact fresh candidate admitted by the
      // kernel; the SQL selector below rechecks its original epoch/revision.
      const pending = await this.#owners.store.pendingOAuthRefresh?.(ctx, this.configuration.enrollment.worker,
        { consumerId: ctx.consumerId, operationId: j.operationId, accountRef: j.accountRef, generation: j.generation }, p);
      if (!pending || pending.ownerRef !== j.ownerRef || pending.worker !== j.worker || pending.purpose !== j.purpose) return denied();
    }
    const mapping = await this.#store.mapping(ctx, j.generation);
    if (mapping && (mapping.consumerId !== ctx.consumerId || mapping.operationId !== j.operationId ||
        mapping.accountRef !== j.accountRef || mapping.ownerRef !== j.ownerRef || mapping.generation !== j.generation ||
        mapping.purpose !== j.purpose || mapping.profile.qualificationRef !== j.profile.qualificationRef ||
        mapping.profile.profile !== j.profile.profile || mapping.profile.baseURL !== j.profile.baseURL ||
        mapping.profile.model !== j.profile.model || !exactCandidate(j, physicalCandidate(mapping.descriptor)))) return denied();
    // No external await after inspecting the live replacement-sensitive grant.
    if (!this.#owners.bearers.authorizesOwner(ctx, j.ownerRef, j.profile.profile)) return denied();
    return { ok: true, ownerRef: j.ownerRef };
  }
  async #refreshOwner(ctx: TrustedContext, value: unknown): Promise<{ ok: true; ownerRef: string }> {
    const r = object(value, ['consumerId','operationId','accountRef','generation']);
    if (!this.#refreshOwners || r.consumerId !== ctx.consumerId) return denied();
    identifier(r.operationId); uuid(r.accountRef); uuid(r.generation);
    const original = await this.#refreshOwners.store.readJournal(ctx, r.operationId);
    const p = this.#oauthProfile(original);
    if (!p) return denied();
    const selectors = { consumerId: ctx.consumerId, operationId: r.operationId,
      accountRef: r.accountRef, generation: r.generation };
    const active = await this.#refreshOwners.store.activeOAuthRefresh?.(ctx,
      this.configuration.enrollment.worker, selectors, p);
    const j = active ?? await this.#refreshOwners.store.pendingOAuthRefresh?.(ctx,
      this.configuration.enrollment.worker, selectors, p);
    if (!j || j.consumerId !== ctx.consumerId || j.operationId !== r.operationId ||
        j.accountRef !== r.accountRef || j.generation !== r.generation || !['create','reconnect'].includes(j.purpose) ||
        j.profile.profile !== p.profile || j.profile.baseURL !== p.baseURL || j.profile.model !== p.model ||
        j.profile.qualificationRef !== p.qualificationRef) return denied();
    if (active ? !exactCandidate(active, physicalCandidate(active.descriptor)) :
        !['create','reconnect'].includes(j.purpose) || j.worker !== this.configuration.enrollment.worker) return denied();
    identifier(j.ownerRef);
    // Final synchronous lookup observes replacement during the SQL await.
    if (!this.#refreshOwners.bearers.authorizesOwner(ctx, j.ownerRef, j.profile.profile)) return denied();
    return { ok: true, ownerRef: j.ownerRef };
  }
  async #cleanupOwner(ctx: TrustedContext, value: unknown): Promise<unknown> {
    const r = object(value, ['consumerId','operationId','accountRef','generation','cleanupRef','cleanupToken','action']);
    if (!this.#cleanupOwners?.store.oauthCleanup || r.consumerId !== ctx.consumerId ||
        (r.action !== 'read' && r.action !== 'erase')) return denied();
    identifier(r.operationId); uuid(r.accountRef); uuid(r.generation); uuid(r.cleanupRef); uuid(r.cleanupToken);
    const original = await this.#cleanupOwners.store.readJournal(ctx, r.operationId);
    const p = this.#oauthProfile(original, true);
    if (!p) return denied();
    const owned = await this.#cleanupOwners.store.oauthCleanup(ctx, this.configuration.enrollment.worker,
      { cleanupRef: r.cleanupRef, cleanupToken: r.cleanupToken }, r.action, p,
      { consumerId: ctx.consumerId, operationId: r.operationId, accountRef: r.accountRef, generation: r.generation });
    if (!owned || owned.journal.consumerId !== ctx.consumerId || owned.journal.operationId !== r.operationId ||
        owned.journal.accountRef !== r.accountRef || owned.journal.generation !== r.generation ||
        owned.journal.profile.profile !== p.profile || owned.journal.profile.baseURL !== p.baseURL ||
        !oauthProfileDefinition(p.profile)!.cleanupModels.includes(owned.journal.profile.model) || owned.journal.profile.qualificationRef !== p.qualificationRef ||
        instant(owned.leaseExpiresAt) <= now()) return denied();
    identifier(owned.journal.ownerRef);
    const native = owned.native && physicalCandidate(owned.native);
    if (native && !exactCandidate(owned.journal, native)) return denied();
    return { ok: true, ownerRef: owned.journal.ownerRef, leaseExpiresAt: owned.leaseExpiresAt,
      ...(native ? { native: descriptor(native) } : {}) };
  }
  async persisted(ctx: TrustedContext, p: NativeDispatchProof): Promise<void> {
    this.consumer(ctx);
    const e = this.configuration.enrollment;
    if (p.native.originRef !== e.originRef || p.native.engineIncarnation !== e.engineIncarnation) return denied();
    const actual = await this.kernel.requestProof(ctx, p.executionRef, p.requestRef);
    if (!actual || !sameProof(proof(actual), p)) return denied();
    // Original proofs remain valid for closure after deadline/lease/fence loss.
  }
  async dispatch(ctx: TrustedContext, p: NativeDispatchProof, expires: unknown): Promise<void> {
    if (p.worker !== this.configuration.enrollment.worker) return denied();
    const requested = instant(expires);
    this.consumer(ctx);
    const e = this.configuration.enrollment;
    if (p.native.originRef !== e.originRef || p.native.engineIncarnation !== e.engineIncarnation) return denied();
    const snapshot = this.kernel.dispatchSnapshot && await this.kernel.dispatchSnapshot(ctx, p.executionRef, p.worker, p.requestRef);
    const actual = snapshot ? snapshot.proof : await this.kernel.requestProof(ctx, p.executionRef, p.requestRef);
    if (!actual || !sameProof(proof(actual), p)) return denied();
    const execution = saved(snapshot ? snapshot.saved : await this.kernel.savedExecution(ctx, p.executionRef));
    const lease = instant(snapshot ? snapshot.workerLeaseExpiresAt : await this.kernel.currentWorkerLease(ctx, p.worker));
    const status = snapshot?.status ?? await this.kernel.request(ctx, p.executionRef, p.requestRef);
    if (snapshot && snapshot.issuerEpoch !== execution.admission.issuerEpoch) return denied();
    if (!execution.dispatchAllowed || execution.state !== 'open' || execution.generation !== p.native.generation ||
        !['dispatch_started','response_started'].includes(status.effect) || requested <= now() || requested > lease ||
        requested > instant(execution.admission.expiresAt)) return denied();
  }
  async delegated(ctx: TrustedContext, p: NativeDispatchProof, value: unknown): Promise<ReturnType<typeof cleanup>> {
    const c = cleanup(value);
    if (c.worker !== this.configuration.enrollment.worker) return denied();
    await this.persisted(ctx, p);
    const actual = instant(await this.kernel.currentCleanupLease(ctx, c.cleanupRef, c.worker, c.token));
    if (instant(c.leaseExpiresAt) !== actual || actual <= now()) return denied();
    const scoped = await this.kernel.cleanupTransports(ctx, c.cleanupRef, c.worker, c.token);
    if (actual <= now() || !scoped.some(s => s.token && s.native && sameProof(proof(s), p))) return denied();
    return c;
  }
  async #publicExecution(ctx: TrustedContext, value: unknown) {
    const r = object(value, ['executionBearer','requestRef'], ['executionRef','admission']);
    identifier(r.requestRef);
    if (!this.#executionBearers || typeof r.executionBearer !== 'string' ||
        !/^[A-Za-z0-9._~-]{16,1024}$/.test(r.executionBearer)) return denied();
    const grant = await this.#executionBearers.resolveExecution(r.executionBearer, this.kernel);
    if (!grant || grant.role !== 'execution' || grant.consumerId !== ctx.consumerId || !this.#executionBearers.current(grant)) return denied();
    const snapshot = this.kernel.dispatchSnapshot && await this.kernel.dispatchSnapshot(ctx, grant.saved.admission.executionRef, this.configuration.enrollment.worker);
    const fresh = saved(snapshot ? snapshot.saved : await this.kernel.savedExecution(ctx, grant.saved.admission.executionRef));
    if (snapshot && snapshot.issuerEpoch !== fresh.admission.issuerEpoch) return denied();
    if (!sameAdmission(fresh.admission, grant.saved.admission) || fresh.generation !== grant.saved.generation ||
        !fresh.dispatchAllowed || fresh.state !== 'open' || instant(fresh.admission.expiresAt) <= now() ||
        r.executionRef !== undefined && r.executionRef !== fresh.admission.executionRef) return denied();
    if (r.admission !== undefined) {
      const publicAdmission = c.admission.safeParse(r.admission);
      if (!publicAdmission.success || !sameAdmission({ ...publicAdmission.data, executionRef: fresh.admission.executionRef,
        issuerEpoch: fresh.admission.issuerEpoch }, fresh.admission)) return denied();
    }
    const mapping = await this.#store.mapping(ctx, fresh.generation), profile = this.configuration.profiles.find(p => p.profile === fresh.admission.profileId);
    if (!mapping || !profile || mapping.consumerId !== ctx.consumerId || mapping.accountRef !== fresh.admission.accountRef ||
        mapping.generation !== fresh.generation || mapping.profile.profile !== profile.profile || mapping.profile.model !== profile.model ||
        mapping.profile.baseURL !== profile.baseURL || mapping.profile.qualificationRef !== profile.qualificationRef) return denied();
    const d = descriptor(physicalCandidate(mapping.descriptor)), limits = this.#limits.get(profile.profile);
    if (d.generation !== fresh.generation || mapping.descriptor.nativePhysicalIdentity !== fresh.generation || d.profile !== profile.profile ||
        d.model !== profile.model || d.base_url !== profile.baseURL || fresh.admission.limits.requestBytes > profile.requestBytes ||
        fresh.admission.limits.outputBytes > profile.outputBytes || fresh.admission.limits.tokens > profile.tokens ||
        limits && (Object.keys(limits) as (keyof ApprovedLimits)[]).some(k => fresh.admission.limits[k] > limits[k])) return denied();
    const lease = snapshot ? snapshot.workerLeaseExpiresAt : await this.kernel.currentWorkerLease(ctx, this.configuration.enrollment.worker);
    if (!this.#executionBearers.current(grant) || instant(lease) <= now()) return denied();
    return { grant, saved: fresh, descriptor: d, lease };
  }
  async #publicAuthority(ctx: TrustedContext, value: unknown): Promise<unknown> {
    const r = object(value, ['executionBearer','requestRef'], ['executionRef','admission']);
    const authorized = await this.#publicExecution(ctx, r);
    return { consumerId: ctx.consumerId, requestRef: r.requestRef, worker: this.configuration.enrollment.worker,
      admission: authorized.saved.admission, descriptor: authorized.descriptor };
  }
  async #publicAdmit(ctx: TrustedContext, value: unknown): Promise<unknown> {
    const r = object(value, ['consumerId','requestRef','worker','admission','descriptor','native','executionBearer']);
    if (r.consumerId !== ctx.consumerId) return denied();
    const admitted = admission(r.admission), native = binding(r.native), e = this.configuration.enrollment;
    const authorized = await this.#publicExecution(ctx, { executionBearer: r.executionBearer, requestRef: r.requestRef,
      executionRef: admitted.executionRef });
    if (r.worker !== e.worker || native.originRef !== e.originRef || native.engineIncarnation !== e.engineIncarnation ||
        native.generation !== authorized.saved.generation || !sameAdmission(admitted, authorized.saved.admission) ||
        !sameDescriptor(r.descriptor, authorized.descriptor)) return denied();
    if (!this.#executionBearers!.current(authorized.grant)) return denied();
    const claim = await this.kernel.claim(ctx, admitted.executionRef, r.requestRef as string, e.worker, admitted,
      { originRef: e.originRef, engineIncarnation: e.engineIncarnation, requestNonce: native.requestNonce });
    const reply = { consumerId: ctx.consumerId, admission: admitted, status: claim.status };
    if (!claim.dispatch) return reply;
    const p = proof(claim.dispatch.closure);
    try {
      const lease = await this.kernel.currentWorkerLease(ctx, e.worker);
      const expires = new Date(Math.min(Date.parse(lease), Date.parse(admitted.expiresAt))).toISOString();
      if (!this.#executionBearers!.current(authorized.grant) || !sameProof({ ...p, native }, p) ||
          claim.dispatch.descriptor.generation !== authorized.saved.generation ||
          claim.dispatch.descriptor.nativePhysicalIdentity !== authorized.saved.generation ||
          claim.dispatch.descriptor.profile !== admitted.profileId) return denied();
      await this.dispatch(ctx, p, expires);
      await this.#recordPublicUsage(ctx, authorized.saved, r.requestRef as string, claim.status.effect).catch(() => undefined);
      return { ...reply, dispatch: claim.dispatch, nativeDescriptor: authorized.descriptor, leaseExpiresAt: expires };
    } catch {
      await this.kernel.effect(ctx, admitted.executionRef, r.requestRef as string, e.worker, 'effect_unknown');
      return denied();
    }
  }
  async #recordPublicUsage(ctx: TrustedContext, execution: SavedExecution, requestRef: string,
    effect: RequestStatus['effect'], closed?: ReturnType<typeof receipt>): Promise<void> {
    if (!this.#usage) return;
    const a = execution.admission, previous = await this.#usage.observe(ctx, a.executionRef, requestRef);
    const observed = closed?.nativeUsage;
    await this.#usage.append(ctx, { schemaVersion: 1, eventId: createHash('sha256').update(a.executionRef + ':' + requestRef).digest('hex'),
      revision: closed ? 2 : 0, executionRef: a.executionRef, requestRef, invocationRef: a.invocationRef, attemptRef: a.attemptRef,
      accountRef: a.accountRef, profileId: a.profileId, model: this.configuration.profiles.find(p => p.profile === a.profileId)!.model,
      occurredAt: previous?.occurredAt ?? new Date().toISOString(), effect, completeness: observed?.state === 'complete' ? 'complete' : 'partial',
      inputTokens: observed?.inputTokens ?? null, outputTokens: observed?.outputTokens ?? null,
      cachedInputTokens: observed?.cachedInputTokens ?? null, reasoningTokens: observed?.reasoningOutputTokens ?? null, cost: null });
  }
  async #publicSettle(ctx: TrustedContext, value: unknown): Promise<void> {
    const r = object(value, ['consumerId','proof','receipt']);
    if (r.consumerId !== ctx.consumerId) return denied();
    const p = proof(r.proof); await this.persisted(ctx, p);
    const closed = receipt(r.receipt, ctx.consumerId, p);
    if (!physicallyClosed(closed)) return denied();
    let status = await this.kernel.request(ctx, p.executionRef, p.requestRef);
    if (!closed.lifetime.entered) {
      if (status.effect === 'dispatch_started') status = await this.kernel.rejectBeforeDispatch(ctx, p.worker, p, false);
    } else if (closed.lifetime.completed && closed.effect === 'completed') {
      if (status.effect === 'dispatch_started') status = await this.kernel.effect(ctx, p.executionRef, p.requestRef, p.worker, 'response_started');
      if (status.effect === 'response_started') status = await this.kernel.effect(ctx, p.executionRef, p.requestRef, p.worker, 'completed');
    } else status = await this.kernel.effect(ctx, p.executionRef, p.requestRef, p.worker, 'effect_unknown');
    const execution = await this.kernel.savedExecution(ctx, p.executionRef);
    await this.#recordPublicUsage(ctx, execution, p.requestRef, status.effect, closed);
    await this.kernel.acknowledgeTransportClosed(ctx, p.worker, p);
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
  createServer(admit?: (req: IncomingMessage, res: ServerResponse, work: () => Promise<void>, refusedBeforeWork?: () => void) => void): Server {
    const cfg = this.configuration;
    const server = createServer({ maxHeaderSize: 16_384, headersTimeout: cfg.timeoutMs, requestTimeout: cfg.timeoutMs,
      keepAliveTimeout: 1000, connectionsCheckingInterval: 100 }, (req, res) => {
      const send = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(body)); } };
      // Authenticate before scheduling. Only a fixed private caller can receive
      // the purpose-specific, nonce-bound proof that claim work never began.
      let consumerId: string, reservationNonce: string | undefined;
      try {
        if (req.method !== 'POST' || !req.url || !/^\/private\/native\/v1\/(enrollment|admit|execution-authority|public-admit|execution-settle|dispatch-proof|cleanup-authority|owner-closure-authority|closure-ack|oauth-owner-authority|oauth-custody-authority|oauth-refresh-authority|oauth-cleanup-authority|account-limits-authority)$/.test(req.url) ||
            req.rawHeaders.length > 64 || singleton(req, 'content-type') !== 'application/json' ||
            req.rawHeaders.some((h, i) => i % 2 === 0 && ['content-encoding','transfer-encoding'].includes(h.toLowerCase()))) return denied();
        const authorization = singleton(req, 'authorization');
        if (!authorization || authorization.length > 1031 || !/^Bearer [A-Za-z0-9._~+/-]{16,1024}=*$/.test(authorization)) return denied();
        const h = hash(authorization.slice(7)), caller = this.#callers.find(c => timingSafeEqual(c.hash, h));
        if (!caller) return denied();
        consumerId = caller.consumerId;
        reservationNonce = singleton(req, 'x-gateway-reservation-nonce');
        if (reservationNonce === undefined && req.rawHeaders.some((h, i) => i % 2 === 0 && h.toLowerCase() === 'x-gateway-reservation-nonce')) return denied();
        if (reservationNonce !== undefined) uuid(reservationNonce);
      } catch { send(403, { code: 'denied' }); return; }
      const work = () => {
      const timer = setTimeout(() => { req.destroy(); res.destroy(); }, cfg.timeoutMs);
      res.once('close', () => clearTimeout(timer)); res.once('finish', () => clearTimeout(timer));
      return (async () => {
        const path = req.url!;
        const limitsLookup = path.endsWith('/account-limits-authority');
        const ownerLookup = path.endsWith('/oauth-owner-authority');
        const custodyLookup = path.endsWith('/oauth-custody-authority');
        const refreshLookup = path.endsWith('/oauth-refresh-authority');
        const cleanupLookup = path.endsWith('/oauth-cleanup-authority');
        const ctx = Object.freeze({ consumerId }), body = await jsonBody(req, limitsLookup || ownerLookup || custodyLookup || refreshLookup || cleanupLookup ? Math.min(1024, cfg.controlBytes) : cfg.controlBytes);
        if (path.endsWith('/execution-authority')) { send(200, await this.#publicAuthority(ctx, body)); return; }
        if (path.endsWith('/public-admit')) {
          if (reservationNonce !== undefined && binding((body as Record<string, unknown>).native).requestNonce !== reservationNonce) return denied();
          send(200, await this.#publicAdmit(ctx, body)); return;
        }
        if (path.endsWith('/execution-settle')) { await this.#publicSettle(ctx, body); send(200, { ok: true }); return; }
        if (limitsLookup) { send(200, await this.#accountLimitsOwner(ctx, body)); return; }
        if (ownerLookup) { send(200, await this.#owner(ctx, body)); return; }
        if (custodyLookup) { send(200, await this.#custodyOwner(ctx, body)); return; }
        if (refreshLookup) { send(200, await this.#refreshOwner(ctx, body)); return; }
        if (cleanupLookup) { send(200, await this.#cleanupOwner(ctx, body)); return; }
        if (path.endsWith('/enrollment')) {
          const r = object(body, ['originRef','engineIncarnation','qualificationRef']), e = cfg.enrollment;
          if (r.originRef !== e.originRef || r.engineIncarnation !== e.engineIncarnation || r.qualificationRef !== e.qualificationRef) return denied();
        } else if (path.endsWith('/admit')) {
          const r = object(body, ['consumerId','requestRef','worker','admission','descriptor','native']);
          if (r.consumerId !== ctx.consumerId) return denied();
          send(200, await this.#admit(ctx, r)); return;
        } else {
          const route = path.slice(path.lastIndexOf('/') + 1);
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
              const c = r.cleanup === undefined ? undefined : cleanup(r.cleanup);
              if (c && c.worker !== cfg.enrollment.worker) return denied();
              // Closure authorization is atomic and durable, including an exact
              // duplicate after owner closure. Dispatch still uses delegated().
              await this.kernel.acknowledgeTransportClosed(ctx, c?.worker ?? p.worker, p,
                c && { cleanupRef: c.cleanupRef, token: c.token, leaseExpiresAt: c.leaseExpiresAt });
              const a = this.#pending.get(key(ctx, p.executionRef, p.requestRef));
              // A real SQL ACK may precede the admit callback's post-claim lease
              // await. Match the latched reservation, not proof attachment time.
              if (a && a.native && p.worker === cfg.enrollment.worker && p.native.generation === a.saved.generation &&
                  sameProof({ ...p, native: a.native }, p) && (!a.proof || sameProof(a.proof, p))) a.acknowledged = true;
            }
          }
        }
        send(200, { ok: true });
      })().catch(error => {
        if (req.url === '/private/native/v1/execution-authority' && error instanceof KernelError && error.code === 'unavailable') send(503, { code: 'unavailable' });
        else send(403, { code: 'denied' });
      }).finally(() => clearTimeout(timer));
      };
      const refusedBeforeWork = req.url === '/private/native/v1/public-admit' && reservationNonce !== undefined
        ? () => send(503, { kind: 'account-gateway/public-admit-capacity/v1', claim: 'not_started', requestNonce: reservationNonce }) : undefined;
      if (admit) admit(req, res, work, refusedBeforeWork); else void work();
    });
    // Trusted composition may choose a port, never a public bind address.
    server.maxConnections = cfg.maxPending; server.maxRequestsPerSocket = 1;
    server.on('listening', () => { const a = server.address(); if (!a || typeof a === 'string' || !['127.0.0.1','::1'].includes(a.address)) server.close(); });
    server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    return server;
  }
}
