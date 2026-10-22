import { KernelError, identifier, uuid, revision } from './domain.ts';
import { oauthProfileDefinition } from './oauth-profiles.ts';
export { codexOAuthProfile, codexOAuthCleanupModels, claudeOAuthProfile } from './oauth-profiles.ts';
import type { AccountIntent, AccountPage, AccountPageQuery, AccountStatus, DurableKernel,
  OperationStatus, TrustedContext, CleanupClaim, AccountRetirementReadback, PolicyUseClosureReadback,
  RetainedCustodyProof, ResumeCustodyAuthority } from './domain.ts';

// Private consumer-owned ports. They are not SDK DTOs or an inference authority.
export interface ManagedProfile {
  readonly profile: string; readonly baseURL: string; readonly model: string;
  // Receipt comes from trusted fixture/non-inference qualification, never ingress.
  readonly qualificationRef: string;
}
export interface CandidateScope {
  readonly consumerId: string; readonly operationId: string; readonly accountRef: string;
  readonly ownerRef: string; readonly purpose: 'create' | 'reconnect';
}
export interface PhysicalCandidate {
  readonly generation: string; readonly nativePhysicalIdentity: string; readonly nativeId: number;
  readonly createdAt: string; readonly profile: string; readonly baseURL: string; readonly model: string;
}
export interface NativeReadback extends PhysicalCandidate { readonly state: 'inactive' | 'active' }
export interface CandidateJournal extends CandidateScope {
  readonly generation: string; readonly worker: string; readonly profile: ManagedProfile;
}
export interface CandidateMapping extends CandidateJournal { readonly descriptor: PhysicalCandidate }
export interface CandidateNative {
  // Each call makes at most one candidate-management HTTP request. Never inference.
  create(scope: CandidateJournal, displayName: string, apiKey: string): Promise<void>;
  read(scope: CandidateJournal): Promise<readonly NativeReadback[]>;
  setState(mapping: CandidateMapping, state: 'active' | 'inactive'): Promise<void>;
  erase(mapping: CandidateMapping): Promise<void>;
}
// Consumer-owned protected enrollment ports. No SDK/vendor DTOs or token data.
// Catalog evidence pins intent; it is never an account qualification receipt.
export interface OAuthScope {
  readonly consumerId: string; readonly operationId: string; readonly ownerRef: string;
  readonly accountRef: string; readonly generation: string;
}
export interface OAuthReadback {
  readonly operationId: string; readonly accountRef: string;
  // Native connect state is distinct from the completed custody outcome
  // "staged" and from the future descriptor's qualification state.
  readonly state: 'prepared' | 'entered' | 'completed' | 'expired' | 'unknown';
}
export interface OAuthBeginReadback extends OAuthReadback {
  readonly authorizationURL?: string;
  readonly deviceAuthorization?: OAuthDeviceAuthorization;
}
export type OAuthMethod = 'device_code' | 'browser';
export interface OAuthDeviceAuthorization {
  readonly userCode: string; readonly verificationURL: string;
  readonly expiresAt: string; readonly intervalSeconds: number;
}
export interface OAuthEnrollmentNative {
  begin(scope: OAuthScope, method?: OAuthMethod): Promise<OAuthBeginReadback>;
  read(scope: OAuthScope): Promise<OAuthReadback>;
  complete(scope: OAuthScope, callback: OAuthCallback): Promise<OAuthReadback>;
  poll(scope: OAuthScope): Promise<OAuthReadback>;
}
export interface OAuthRefreshReadback {
  readonly operationId: string; readonly accountRef: string;
  readonly state: 'idle' | 'prepared' | 'entered' | 'completed' | 'unknown';
  readonly refreshRef?: string;
}
export interface OAuthRefreshNative {
  // Native alone owns due time, credential version and durable attempt identity.
  refresh(scope: OAuthScope): Promise<OAuthRefreshReadback>;
}
export interface OAuthCleanupAuthority {
  readonly cleanupRef: string; readonly cleanupToken: string;
}
export type OAuthCleanupAction = 'read' | 'erase';
export interface OAuthCleanupReadback {
  readonly operationId: string; readonly accountRef: string;
  readonly credentialsErased: boolean; readonly closure: 'pending' | 'closed' | 'unknown';
  readonly native?: PhysicalCandidate;
}
export interface OAuthLifecycleNative {
  cleanup(scope: OAuthScope, authority: OAuthCleanupAuthority, action: OAuthCleanupAction): Promise<OAuthCleanupReadback>;
}
export interface OAuthCleanupScope {
  readonly journal: CandidateJournal; readonly leaseExpiresAt: string; readonly native?: PhysicalCandidate;
}
export type OAuthSelectors = Pick<OAuthScope, 'consumerId' | 'operationId' | 'accountRef' | 'generation'>;
export type OAuthDescriptor = {
  readonly operationId: string; readonly accountRef: string;
} & ({ readonly state: 'staged'; readonly qualification: 'pending' } |
  { readonly state: 'qualified'; readonly qualification: 'controlled-source-v1'; readonly native: PhysicalCandidate });
export interface OAuthDescriptorBoundary {
  // Exact protected inert physical birth and native source qualification.
  describe(scope: OAuthScope): Promise<OAuthDescriptor>;
}
export interface OAuthEnrollmentOptions {
  readonly profile: ManagedProfile; readonly native: OAuthEnrollmentNative;
  readonly descriptor?: OAuthDescriptorBoundary;
  readonly lifecycle?: OAuthLifecycleNative;
  readonly refresh?: OAuthRefreshNative;
}
export interface OAuthCallback { readonly state: string; readonly code: string }
export interface OAuthCompleteInput extends OAuthCallback { readonly operationId: string; readonly ownerRef: string }
export interface OAuthBeginInput {
  readonly operationId: string; readonly ownerRef: string;
  readonly profile: string; readonly displayName: string;
  readonly method?: OAuthMethod;
}
export interface OAuthReconnectInput {
  readonly operationId: string; readonly accountRef: string; readonly expectedRevision: number;
  readonly method?: OAuthMethod;
}
export interface OAuthPollInput { readonly operationId: string; readonly ownerRef: string }
export interface OAuthBeginResult {
  readonly operation: OperationStatus;
  readonly authorizationURL?: string;
  readonly deviceAuthorization?: OAuthDeviceAuthorization;
}
function deviceMethod(method: OAuthMethod | undefined): Pick<AccountIntent, 'oauthMethod'> {
  if (method !== undefined && method !== 'device_code' && method !== 'browser') throw new KernelError('invalid');
  return method === 'device_code' ? { oauthMethod: method } : {};
}
function oauthScope(j: CandidateJournal): OAuthScope {
  return Object.freeze({ consumerId: j.consumerId, operationId: j.operationId,
    ownerRef: j.ownerRef, accountRef: j.accountRef, generation: j.generation });
}
function exactOAuthReadback(scope: OAuthScope, r: OAuthReadback): boolean {
  return r.operationId === scope.operationId && r.accountRef === scope.accountRef &&
    ['prepared','entered','completed','expired','unknown'].includes(r.state);
}
export interface ControlledProof {
  // Trusted qualified inert readback; MUST NOT probe a provider or compare tokens.
  verify(scope: CandidateJournal, descriptor: PhysicalCandidate): Promise<boolean>;
}
// Exact native custody attestation is a separate write-only boundary. It must
// prove the same mapping and retained credential capability without inference,
// token comparison, retirement or deletion.
export interface RetainedCustodyVerifier {
  verify(mapping: CandidateMapping): Promise<RetainedCustodyProof | undefined>;
}
export type ResumeCustodyState = 'not_applicable' | 'verified' | 'attention_required';
export interface AccountLifecycleReadback {
  account: AccountStatus; authKind: 'api_key' | 'oauth'; resumeCustody: ResumeCustodyState;
}
export interface AcceptedIntent {
  readonly context: TrustedContext; readonly intent: AccountIntent; readonly apiKey?: string;
}
export interface IntentCustody {
  digest(accepted: AcceptedIntent): string;
}
// Required read-only lifecycle attestation. Kernel execution consumers remain
// unchanged; AccountManagement delegates to this concrete store capability.
export interface AccountRetirementRead {
  retirement(context: TrustedContext, accountRef: string, operationId: string): Promise<AccountRetirementReadback | undefined>;
}
export interface PolicyUseClosureRead {
  policyClosure(context: TrustedContext, operationId: string): Promise<PolicyUseClosureReadback | undefined>;
}
export interface ManagementStore extends AccountRetirementRead, PolicyUseClosureRead {
  stage(scope: CandidateScope, apiKey: string): Promise<boolean>;
  journal(scope: CandidateScope, generation: string, worker: string, profile: ManagedProfile): Promise<CandidateJournal>;
  readJournal(context: TrustedContext, operationId: string): Promise<CandidateJournal | undefined>;
  credential(scope: CandidateScope): Promise<string | undefined>;
  eraseIntent(scope: CandidateScope): Promise<void>;
  saveMapping(mapping: CandidateMapping): Promise<void>;
  mapping(context: TrustedContext, generation: string): Promise<CandidateMapping | undefined>;
  cleanupAllowed(context: TrustedContext, cleanupRef: string, worker: string, token: string,
    generation: string, identity: string, profile: string): Promise<boolean>;
  expire(context: TrustedContext): Promise<readonly CandidateJournal[]>;
  // Optional for existing enrollment-only adapters; absence cannot grant refresh.
  nextOAuthRefresh?(context: TrustedContext, worker: string, profile: ManagedProfile,
    after?: string): Promise<CandidateMapping | undefined>;
  activeOAuthRefresh?(context: TrustedContext, worker: string, selectors: OAuthSelectors,
    profile: ManagedProfile): Promise<CandidateMapping | undefined>;
  pendingOAuthRefresh?(context: TrustedContext, worker: string, selectors: OAuthSelectors,
    profile: ManagedProfile): Promise<CandidateJournal | undefined>;
  oauthCleanup?(context: TrustedContext, worker: string, authority: OAuthCleanupAuthority,
    action: OAuthCleanupAction, profile: ManagedProfile, selectors?: OAuthSelectors): Promise<OAuthCleanupScope | undefined>;
}
export type CreateInput = Pick<AccountIntent, 'operationId' | 'ownerRef' | 'profile' | 'displayName'> & { apiKey: string };
export type ReconnectInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision'> & { apiKey: string };
export type RenameInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision' | 'displayName'>;
export type DisableInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision'>;
export type SuspendInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision'>;
export type ResumeInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision'>;

export function captureContext(context: TrustedContext): TrustedContext {
  const consumerId = context.consumerId; identifier(consumerId);
  return Object.freeze({ consumerId });
}
function key(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') < 1 ||
      Buffer.byteLength(value, 'utf8') > 4096 || value.trim() !== value || /[\u0000\r\n]/.test(value)) throw new KernelError('invalid');
}
function name(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length < 1 || value.length > 128 ||
      Buffer.byteLength(value, 'utf8') > 400) throw new KernelError('invalid');
}
export function exactCandidate(j: CandidateJournal, d: PhysicalCandidate): boolean {
  return d.generation === j.generation && d.nativePhysicalIdentity === j.generation &&
    d.profile === j.profile.profile && d.baseURL === j.profile.baseURL && d.model === j.profile.model;
}
export function sameCandidate(a: PhysicalCandidate, b: PhysicalCandidate): boolean {
  return a.generation === b.generation && a.nativePhysicalIdentity === b.nativePhysicalIdentity &&
    a.nativeId === b.nativeId && a.createdAt === b.createdAt && a.profile === b.profile &&
    a.baseURL === b.baseURL && a.model === b.model;
}
// Keep RFC3339 text verbatim. No Date conversion, ID-only or latest-row recovery.
export function physicalCandidate(input: PhysicalCandidate): PhysicalCandidate {
  const d = { generation: input.generation, nativePhysicalIdentity: input.nativePhysicalIdentity,
    nativeId: input.nativeId, createdAt: input.createdAt, profile: input.profile,
    baseURL: input.baseURL, model: input.model };
  uuid(d.generation); uuid(d.nativePhysicalIdentity); identifier(d.profile, 64);
  if (!Number.isSafeInteger(d.nativeId) || d.nativeId < 1 || typeof d.createdAt !== 'string' ||
      d.createdAt.length > 64 || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(d.createdAt) ||
      typeof d.baseURL !== 'string' || d.baseURL.length > 2048 ||
      typeof d.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(d.model)) throw new KernelError('invalid');
  const year = Number(d.createdAt.slice(0,4)), month = Number(d.createdAt.slice(5,7)), day = Number(d.createdAt.slice(8,10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (year < 1 || day > days[month - 1]) throw new KernelError('invalid');
  let url: URL;
  try { url = new URL(d.baseURL); } catch { throw new KernelError('invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new KernelError('invalid');
  return Object.freeze(d);
}

export class AccountManagement {
  private readonly kernel: DurableKernel;
  private readonly store: ManagementStore;
  private readonly custody: IntentCustody;
  private readonly native: CandidateNative;
  private readonly proof: ControlledProof;
  private readonly retainedCustody?: RetainedCustodyVerifier;
  private readonly worker: string;
  private readonly profiles: ReadonlyMap<string, ManagedProfile>;
  private readonly oauthProviders: ReadonlyMap<string, Readonly<OAuthEnrollmentOptions>>;
  private readonly refreshCursors = new Map<string, string>();
  private refreshProfileCursor = 0;
  private refreshInFlight = false;
  constructor(options: { kernel: DurableKernel; store: ManagementStore; custody: IntentCustody;
    native: CandidateNative; proof: ControlledProof; worker: string; profiles: readonly ManagedProfile[];
    oauth?: OAuthEnrollmentOptions; oauthProviders?: readonly OAuthEnrollmentOptions[]; refresh?: OAuthRefreshNative; retainedCustody?: RetainedCustodyVerifier }) {
    uuid(options.worker);
    if (!options.profiles.length || options.profiles.length > 128) throw new KernelError('invalid');
    const profiles = new Map<string, ManagedProfile>();
    const oauthProviders = new Map<string, Readonly<OAuthEnrollmentOptions>>();
    for (const entry of [...(options.oauth ? [{ ...options.oauth, refresh: options.refresh ?? options.oauth.refresh }] : []),
      ...(options.oauthProviders ?? [])]) {
      const definition = oauthProfileDefinition(entry.profile.profile);
      if (!definition || entry.profile.baseURL !== definition.baseURL || entry.profile.model !== definition.model ||
          oauthProviders.has(entry.profile.profile)) throw new KernelError('invalid');
      oauthProviders.set(entry.profile.profile, Object.freeze({ ...entry, profile: Object.freeze({ ...entry.profile }) }));
    }
    for (const source of [...options.profiles, ...[...oauthProviders.values()].map(entry => entry.profile)]) {
      const p = Object.freeze({ profile: source.profile, baseURL: source.baseURL, model: source.model,
        qualificationRef: source.qualificationRef });
      identifier(p.profile, 64); identifier(p.qualificationRef);
      physicalCandidate({ generation: options.worker, nativePhysicalIdentity: options.worker, nativeId: 1,
        createdAt: '2000-01-01T00:00:00Z', ...p });
      if (profiles.has(p.profile)) throw new KernelError('invalid');
      profiles.set(p.profile, p);
    }
    if (profiles.size > 128 || [...profiles.keys()].some(id => oauthProfileDefinition(id) && !oauthProviders.has(id))) throw new KernelError('invalid');
    this.kernel = options.kernel; this.store = options.store; this.custody = options.custody;
    this.native = options.native; this.proof = options.proof; this.worker = options.worker; this.profiles = profiles;
    this.retainedCustody = options.retainedCustody;
    this.oauthProviders = oauthProviders;
  }
  async refreshOAuth(context: TrustedContext, cleanupAcquired = false,
    signal?: AbortSignal): Promise<'idle' | 'deferred' | 'observed'> {
    const ctx = captureContext(context);
    if (signal?.aborted || cleanupAcquired || this.refreshInFlight || !this.store.nextOAuthRefresh) return 'idle';
    const refreshable = [...this.oauthProviders.values()].filter(entry => entry.refresh);
    if (!refreshable.length) return 'idle';
    const oauth = refreshable[this.refreshProfileCursor++ % refreshable.length];
    const refreshNative = oauth.refresh!;
    this.refreshInFlight = true;
    try {
      const mapping = await this.store.nextOAuthRefresh(ctx, this.worker, oauth.profile, this.refreshCursors.get(oauth.profile.profile));
      if (!mapping) { this.refreshCursors.delete(oauth.profile.profile); return 'idle'; }
      // Advance before external await, including a dropped ACK or native UNKNOWN.
      // This hint is never an authority, retry receipt or durable refresh ledger.
      this.refreshCursors.set(oauth.profile.profile, mapping.generation);
      if (mapping.consumerId !== ctx.consumerId || mapping.profile.profile !== oauth.profile.profile ||
          mapping.profile.baseURL !== oauth.profile.baseURL || mapping.profile.model !== oauth.profile.model ||
          mapping.profile.qualificationRef !== oauth.profile.qualificationRef ||
          !exactCandidate(mapping, physicalCandidate(mapping.descriptor))) throw new KernelError('conflict');
      let result: OAuthRefreshReadback;
      try {
        if (signal?.aborted) return 'idle';
        result = await refreshNative.refresh(oauthScope(mapping));
      }
      catch { return 'deferred'; }
      if (result.operationId !== mapping.operationId || result.accountRef !== mapping.accountRef ||
          !['idle','prepared','entered','completed','unknown'].includes(result.state)) return 'deferred';
      return result.state === 'unknown' ? 'deferred' : 'observed';
    } finally { this.refreshInFlight = false; }
  }
  supportsOAuthProfile(profile: string): boolean {
    return this.oauthProviders.has(profile);
  }
  async beginOAuth(context: TrustedContext, input: OAuthBeginInput): Promise<OAuthBeginResult> {
    const ctx = captureContext(context);
    // Capture primitives before any await. Owner authorization belongs to the
    // trusted facade management grant, not caller-selected native headers.
    const intent: AccountIntent = { kind: 'create', operationId: input.operationId,
      ownerRef: input.ownerRef, profile: input.profile, displayName: input.displayName, intentDigest: '', ...deviceMethod(input.method) };
    identifier(intent.operationId); identifier(intent.ownerRef); identifier(intent.profile, 64); name(intent.displayName);
    if (!this.supportsOAuthProfile(intent.profile!) || (input.method === 'device_code' && !oauthProfileDefinition(intent.profile!)?.deviceCode)) throw new KernelError('denied');
    return this.beginOAuthIntent(ctx, intent);
  }
  async beginOAuthReconnect(context: TrustedContext, input: OAuthReconnectInput): Promise<OAuthBeginResult> {
    const ctx = captureContext(context);
    const intent: AccountIntent = { kind: 'reconnect', operationId: input.operationId,
      accountRef: input.accountRef, expectedRevision: input.expectedRevision, intentDigest: '', ...deviceMethod(input.method) };
    identifier(intent.operationId); uuid(intent.accountRef); revision(intent.expectedRevision);
    const account = await this.kernel.account(ctx, intent.accountRef!);
    if (!this.supportsOAuthProfile(account.profile) || (input.method === 'device_code' && !oauthProfileDefinition(account.profile)?.deviceCode)) throw new KernelError('denied');
    return this.beginOAuthIntent(ctx, intent);
  }
  private async beginOAuthIntent(ctx: TrustedContext, intent: AccountIntent): Promise<OAuthBeginResult> {
    // No secret is staged in TS SQL. Native owns PKCE/state and token custody.
    intent.intentDigest = this.custody.digest({ context: ctx, intent });
    const operation = await this.kernel.beginAccount(ctx, Object.freeze(intent));
    if (operation.state !== 'pending') return Object.freeze({ operation });
    if (!operation.accountRef) throw new KernelError('unavailable');
    const account = await this.kernel.account(ctx, operation.accountRef);
    if (intent.kind === 'create' && (account.ownerRef !== intent.ownerRef || account.profile !== intent.profile)) throw new KernelError('conflict');
    if (!this.supportsOAuthProfile(account.profile)) throw new KernelError('denied');
    const oauth = this.oauthProviders.get(account.profile)!;
    const old = await this.store.readJournal(ctx, intent.operationId);
    if (old) return Object.freeze({ operation: await this.oauthReadback(ctx, old) });
    const permit = await this.kernel.startCandidate(ctx, intent.operationId, this.worker);
    if (!permit) {
      // Another request can be between permit and journal. Do not create a new
      // permit, spin, or manufacture missing evidence; bounded pending is valid.
      const spent = await this.store.readJournal(ctx, intent.operationId);
      return Object.freeze({ operation: spent ? await this.oauthReadback(ctx, spent) :
        await this.kernel.operation(ctx, intent.operationId) });
    }
    try {
      if (permit.profile !== oauth.profile.profile || permit.operationRef !== intent.operationId) throw new KernelError('conflict');
      const scope: CandidateScope = Object.freeze({ consumerId: ctx.consumerId, operationId: intent.operationId,
        accountRef: account.accountRef, ownerRef: account.ownerRef, purpose: intent.kind === 'reconnect' ? 'reconnect' : 'create' });
      // Commit original accountRef + immutable birth UUID before the sole Begin.
      const journal = await this.store.journal(scope, permit.candidate, this.worker, oauth.profile);
      let begun: OAuthBeginReadback;
      try { begun = await oauth.native.begin(oauthScope(journal), intent.oauthMethod); }
      catch { return Object.freeze({ operation: await this.oauthReadback(ctx, journal) }); }
      // Invalid ACK is ambiguous. Only Read can recover the same native intent.
      if (!exactOAuthReadback(oauthScope(journal), begun)) {
        return Object.freeze({ operation: await this.oauthReadback(ctx, journal) });
      }
      const current = await this.oauthReadback(ctx, journal, begun);
      // Return only an actually received Begin capability. It is never persisted
      // or reconstructed on duplicate Begin, GET, lost ACK or worker recovery.
      const handoff = intent.oauthMethod === 'device_code'
        ? (begun.deviceAuthorization === undefined ? {} : { deviceAuthorization: begun.deviceAuthorization })
        : (begun.authorizationURL === undefined ? {} : { authorizationURL: begun.authorizationURL });
      return Object.freeze({ operation: current,
        ...(current.state === 'pending' && begun.state === 'prepared' ? handoff : {}) });
    } catch {
      return Object.freeze({ operation: await this.kernel.unknownCandidate(ctx, intent.operationId, this.worker) });
    }
  }
  async completeOAuth(context: TrustedContext, input: OAuthCompleteInput): Promise<OperationStatus> {
    const ctx = captureContext(context), operationId = input.operationId, ownerRef = input.ownerRef;
    const callback = { state: input.state, code: input.code };
    identifier(operationId); identifier(ownerRef);
    if (typeof callback.state !== 'string' || typeof callback.code !== 'string') throw new KernelError('invalid');
    const operation = await this.kernel.operation(ctx, operationId);
    if (operation.oauthMethod === 'device_code') throw new KernelError('denied');
    const journal = await this.store.readJournal(ctx, operationId);
    const oauth = journal && this.oauthProviders.get(journal.profile.profile);
    if (!oauth || !journal || journal.consumerId !== ctx.consumerId || journal.operationId !== operationId ||
        journal.ownerRef !== ownerRef || !['create','reconnect'].includes(journal.purpose) || operation.accountRef !== journal.accountRef ||
        operation.executionRef || journal.profile.profile !== oauth.profile.profile ||
        journal.profile.baseURL !== oauth.profile.baseURL || journal.profile.model !== oauth.profile.model ||
        journal.profile.qualificationRef !== oauth.profile.qualificationRef) throw new KernelError('denied');
    const account = await this.kernel.account(ctx, journal.accountRef);
    if (account.ownerRef !== ownerRef || account.profile !== journal.profile.profile) throw new KernelError('denied');
    // Reuse only this immutable create/reconnect journal. Reconciliation can permanently
    // spend its authority; completion never creates or takes over a candidate.
    await this.kernel.reconcile(ctx);
    const current = await this.kernel.operation(ctx, operationId);
    if (current.state !== 'pending' || journal.worker !== this.worker) return current;
    if (!this.store.pendingOAuthRefresh || !await this.store.pendingOAuthRefresh(ctx, this.worker, oauthScope(journal), oauth.profile))
      return this.kernel.unknownCandidate(ctx, operationId, journal.worker);
    const scope = oauthScope(journal);
    let read: OAuthReadback;
    try { read = await oauth.native.read(scope); }
    catch { return this.kernel.unknownCandidate(ctx, operationId, journal.worker); }
    if (!exactOAuthReadback(scope, read)) return this.kernel.unknownCandidate(ctx, operationId, journal.worker);
    // Entered/completed/expired/unknown native intents are readback only. Native
    // rechecks the live owner grant and performs the sole EnterConnect CAS.
    if (read.state !== 'prepared') return this.oauthReadback(ctx, journal, read);
    const fresh = await this.kernel.operation(ctx, operationId);
    if (fresh.accountRef !== journal.accountRef || fresh.executionRef) throw new KernelError('denied');
    if (fresh.state !== 'pending') return fresh;
    let completed: OAuthReadback;
    try { completed = await oauth.native.complete(scope, callback); }
    catch { return this.kernel.unknownCandidate(ctx, operationId, journal.worker); }
    // A lost/invalid ACK burns Gateway authority too; a later prepared read
    // cannot cause an automatic replay of the sensitive completion body.
    if (!exactOAuthReadback(scope, completed) || completed.state === 'prepared') return this.kernel.unknownCandidate(ctx, operationId, journal.worker);
    return this.oauthReadback(ctx, journal, completed);
  }
  async pollDeviceOAuth(context: TrustedContext, input: OAuthPollInput): Promise<OperationStatus> {
    const ctx = captureContext(context), operationId = input.operationId, ownerRef = input.ownerRef;
    identifier(operationId); identifier(ownerRef);
    const operation = await this.kernel.operation(ctx, operationId);
    const journal = await this.store.readJournal(ctx, operationId);
    const oauth = journal && this.oauthProviders.get(journal.profile.profile);
    if (!oauth || !oauthProfileDefinition(oauth.profile.profile)?.deviceCode || operation.oauthMethod !== 'device_code' || !journal || journal.consumerId !== ctx.consumerId ||
        journal.operationId !== operationId || journal.ownerRef !== ownerRef || !['create','reconnect'].includes(journal.purpose) ||
        operation.accountRef !== journal.accountRef || operation.executionRef || journal.profile.profile !== oauth.profile.profile ||
        journal.profile.baseURL !== oauth.profile.baseURL || journal.profile.model !== oauth.profile.model ||
        journal.profile.qualificationRef !== oauth.profile.qualificationRef) throw new KernelError('denied');
    const account = await this.kernel.account(ctx, journal.accountRef);
    if (account.ownerRef !== ownerRef || account.profile !== journal.profile.profile) throw new KernelError('denied');
    await this.kernel.reconcile(ctx);
    const current = await this.kernel.operation(ctx, operationId);
    if (current.state !== 'pending' || journal.worker !== this.worker) return current;
    // Fresh candidate authority is checked again before the explicit native mutation.
    // Native owns the durable polling interval and sole token-exchange claim.
    const scope = oauthScope(journal);
    if (!this.store.pendingOAuthRefresh || !await this.store.pendingOAuthRefresh(ctx, this.worker, scope, oauth.profile))
      return this.kernel.unknownCandidate(ctx, operationId, journal.worker);
    let result: OAuthReadback;
    try { result = await oauth.native.poll(scope); }
    catch { return this.kernel.unknownCandidate(ctx, operationId, journal.worker); }
    if (!exactOAuthReadback(scope, result)) return this.kernel.unknownCandidate(ctx, operationId, journal.worker);
    return this.oauthReadback(ctx, journal, result);
  }
  private async oauthReadback(ctx: TrustedContext, journal: CandidateJournal,
    begin?: OAuthReadback, allowRefresh = true): Promise<OperationStatus> {
    const oauth = this.oauthProviders.get(journal.profile.profile);
    try {
      if (!oauth || !this.supportsOAuthProfile(journal.profile.profile) || journal.consumerId !== ctx.consumerId ||
          journal.profile.baseURL !== oauth.profile.baseURL || journal.profile.model !== oauth.profile.model ||
          journal.profile.qualificationRef !== oauth.profile.qualificationRef || !['create','reconnect'].includes(journal.purpose)) throw new KernelError('conflict');
      await this.kernel.reconcile(ctx);
      const current = await this.kernel.operation(ctx, journal.operationId);
      if (current.operationRef !== journal.operationId || current.accountRef !== journal.accountRef) throw new KernelError('conflict');
      if (current.state === 'applied' || current.state === 'rejected') return current;
      // Reconciliation/uncertainty permanently spent the original authority.
      // Later custody/qualification cannot turn unknown into a safe rejection,
      // reactivate a row or manufacture a fresh candidate. Cleanup stays scoped
      // to the original journal; absent physical proof it remains quarantined.
      if (current.state === 'unknown') return current;
      // A new worker does not take over a live creating candidate or issue Begin.
      if (current.state === 'pending' && this.worker !== journal.worker) return current;
      const scope = oauthScope(journal);
      const result = begin ?? await oauth.native.read(scope);
      if (!exactOAuthReadback(scope, result) || result.state === 'unknown' || result.state === 'expired') {
        // Expiry/missing/unknown cannot attest token-exchange non-entry or erase
        // an accepted effect. Retain the original spent candidate and cleanup.
        throw new KernelError('conflict');
      }
      // Legitimate user interaction is waiting, not missing/unknown evidence.
      if (result.state === 'prepared' || result.state === 'entered') return current;
      // Recover only the original live creating candidate through native F2.
      // Native validates completed custody and owns the durable one-use ledger;
      // an entered/unknown attempt is observed, never rearmed here.
      if (allowRefresh && oauth.refresh && this.store.pendingOAuthRefresh) {
        const recovery = await this.store.pendingOAuthRefresh(ctx, this.worker, scope, oauth.profile);
        if (!recovery && journal.purpose === 'reconnect') throw new KernelError('conflict');
        if (!recovery || recovery.worker !== journal.worker || recovery.ownerRef !== journal.ownerRef ||
            recovery.generation !== journal.generation || recovery.operationId !== journal.operationId ||
            recovery.accountRef !== journal.accountRef || recovery.consumerId !== journal.consumerId ||
            recovery.purpose !== journal.purpose || recovery.profile.profile !== journal.profile.profile ||
            recovery.profile.baseURL !== journal.profile.baseURL || recovery.profile.model !== journal.profile.model ||
            recovery.profile.qualificationRef !== journal.profile.qualificationRef) return current;
        let refreshed: OAuthRefreshReadback;
        try { refreshed = await oauth.refresh.refresh(scope); }
        catch { return current; } // Lost ACK observes the same native ledger next time.
        if (refreshed.operationId !== scope.operationId || refreshed.accountRef !== scope.accountRef) return current;
        if (refreshed.state === 'unknown') throw new KernelError('conflict');
        if (refreshed.state !== 'idle' && refreshed.state !== 'completed') return current;
      }
      // Completed custody (outcome "staged") still needs protected route proof.
      // An unavailable descriptor boundary preserves truthful pending.
      if (!oauth.descriptor) return current;
      let source: OAuthDescriptor;
      try { source = await oauth.descriptor.describe(scope); }
      catch { return current; } // Unavailable route proof is not a connect failure.
      if (source.operationId !== journal.operationId || source.accountRef !== journal.accountRef) throw new KernelError('conflict');
      if (source.state === 'staged' && source.qualification === 'pending') {
        if ('native' in source) throw new KernelError('conflict');
        return current;
      }
      if (source.state !== 'qualified' || source.qualification !== 'controlled-source-v1') throw new KernelError('conflict');
      const descriptor = physicalCandidate(source.native);
      if (!exactCandidate(journal, descriptor)) throw new KernelError('conflict');
      await this.store.saveMapping(Object.freeze({ ...journal, descriptor }));
      // Qualification can outlive the original worker lease. Observe durable
      // loss again before the logical account ACK. Native remains inert.
      await this.kernel.reconcile(ctx);
      const qualifiedOperation = await this.kernel.operation(ctx, journal.operationId);
      if (qualifiedOperation.state === 'applied' || qualifiedOperation.state === 'rejected') return qualifiedOperation;
      // The native descriptor is the inert physical proof. The kernel decides
      // promotion versus quarantine atomically, including a late disable/lease.
      try {
        return await this.kernel.acknowledgeCandidate(ctx, journal.operationId, journal.worker,
          { generation: descriptor.generation, nativePhysicalIdentity: descriptor.nativePhysicalIdentity, profile: descriptor.profile });
      } catch { return this.kernel.operation(ctx, journal.operationId); } // Lost ACK reads the same operation.
    } catch {
      return this.kernel.unknownCandidate(ctx, journal.operationId, journal.worker);
    }
  }
  async create(context: TrustedContext, input: CreateInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent: AccountIntent = { kind: 'create', operationId: input.operationId, ownerRef: input.ownerRef,
      profile: input.profile, displayName: input.displayName, intentDigest: '' };
    const apiKey = input.apiKey;
    identifier(intent.operationId); identifier(intent.ownerRef); identifier(intent.profile, 64);
    name(intent.displayName); key(apiKey);
    if (!this.profiles.has(intent.profile) || this.supportsOAuthProfile(intent.profile)) throw new KernelError('invalid');
    intent.intentDigest = this.custody.digest({ context: ctx, intent, apiKey });
    return this.connect(ctx, Object.freeze(intent), apiKey);
  }
  async reconnect(context: TrustedContext, input: ReconnectInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent: AccountIntent = { kind: 'reconnect', operationId: input.operationId, accountRef: input.accountRef,
      expectedRevision: input.expectedRevision, intentDigest: '' };
    const apiKey = input.apiKey;
    identifier(intent.operationId); uuid(intent.accountRef); revision(intent.expectedRevision); key(apiKey);
    intent.intentDigest = this.custody.digest({ context: ctx, intent, apiKey });
    return this.connect(ctx, Object.freeze(intent), apiKey);
  }
  private async connect(ctx: TrustedContext, intent: Readonly<AccountIntent>, apiKey: string): Promise<OperationStatus> {
    const operation = await this.kernel.beginAccount(ctx, intent);
    if (operation.state !== 'pending') return operation;
    if (!operation.accountRef) throw new KernelError('unavailable');
    const account = await this.kernel.account(ctx, operation.accountRef);
    const profile = this.profiles.get(account.profile);
    if (!profile) throw new KernelError('invalid');
    if (this.supportsOAuthProfile(account.profile)) throw new KernelError('denied');
    const scope: CandidateScope = Object.freeze({ consumerId: ctx.consumerId, operationId: intent.operationId,
      accountRef: account.accountRef, ownerRef: account.ownerRef, purpose: intent.kind as 'create' | 'reconnect' });
    // A journal means a permit was already spent. Readback can never recreate.
    const old = await this.store.readJournal(ctx, intent.operationId);
    if (old) {
      await this.store.eraseIntent(old);
      return this.readback(ctx, old);
    }
    if (!await this.store.stage(scope, apiKey)) return this.kernel.operation(ctx, intent.operationId);
    const permit = await this.kernel.startCandidate(ctx, intent.operationId, this.worker);
    if (!permit) {
      await this.store.eraseIntent(scope);
      const spent = await this.store.readJournal(ctx, intent.operationId);
      return spent ? this.readback(ctx, spent) : this.kernel.operation(ctx, intent.operationId);
    }
    try {
      if (permit.profile !== profile.profile || permit.operationRef !== intent.operationId) throw new KernelError('conflict');
      const journal = await this.store.journal(scope, permit.candidate, this.worker, profile);
      const credential = await this.store.credential(scope);
      if (credential === undefined) return await this.kernel.unknownCandidate(ctx, intent.operationId, this.worker);
      try { await this.native.create(journal, account.displayName, credential); }
      catch { /* Possibly effected. Only the exact generation GET is allowed. */ }
      // Erase before proof/readback; a lost ACK must not extend custody retention.
      await this.store.eraseIntent(scope);
      return await this.readback(ctx, journal);
    } catch {
      return await this.kernel.unknownCandidate(ctx, intent.operationId, this.worker);
    } finally {
      await this.store.eraseIntent(scope);
    }
  }
  private async readback(ctx: TrustedContext, journal: CandidateJournal, worker = journal.worker,
    activate = true, qualified?: PhysicalCandidate): Promise<OperationStatus> {
    try {
      const candidates = await this.native.read(journal);
      if (candidates.length !== 1 || !['inactive','active'].includes(candidates[0].state)) throw new KernelError('conflict');
      const descriptor = physicalCandidate(candidates[0]);
      if (!exactCandidate(journal, descriptor)) throw new KernelError('conflict');
      if (qualified && !sameCandidate(qualified, descriptor)) throw new KernelError('conflict');
      const existing = await this.store.mapping(ctx,journal.generation);
      // An unexplained already-active row is not inert staging proof. Only a
      // persisted mapping from qualified staging permits activation recovery.
      if (candidates[0].state === 'active' && (!existing || !sameCandidate(existing.descriptor,descriptor))) throw new KernelError('conflict');
      if (candidates[0].state === 'inactive' && !await this.proof.verify(journal, descriptor)) throw new KernelError('conflict');
      const mapping = Object.freeze({ ...journal, descriptor });
      await this.store.saveMapping(mapping); // Durable binding/proof receipt precedes native activation and kernel promotion.
      if (qualified) {
        await this.kernel.reconcile(ctx);
        const current = await this.kernel.operation(ctx, journal.operationId);
        if (current.state !== 'pending') return current;
      }
      if (activate && candidates[0].state === 'inactive') {
        try { await this.native.setState(mapping,'active'); } catch { /* ACK loss: only exact readback, never HTTP retry. */ }
        const active = await this.native.read(journal);
        if (active.length !== 1 || active[0].state !== 'active' || !sameCandidate(descriptor,physicalCandidate(active[0]))) throw new KernelError('conflict');
      }
      // Final ACK atomically observes fences and binds exact cleanup identity,
      // including a disable committed after the pending check or activation.
      return await this.kernel.acknowledgeCandidate(ctx, journal.operationId, worker,
        { generation: descriptor.generation, nativePhysicalIdentity: descriptor.nativePhysicalIdentity, profile: descriptor.profile });
    } catch {
      return this.kernel.unknownCandidate(ctx, journal.operationId, journal.worker);
    }
  }
  // Explicit private recovery can bind cleanup identity after owner loss. Kernel
  // quarantine prevents promotion; this does not acquire another create permit.
  async recover(context: TrustedContext, operationId: string): Promise<OperationStatus> {
    const ctx = captureContext(context); identifier(operationId);
    const operation = await this.kernel.operation(ctx, operationId);
    const journal = await this.store.readJournal(ctx, operationId);
    if (!journal) return operation;
    if (this.supportsOAuthProfile(journal.profile.profile)) return this.oauthReadback(ctx, journal);
    await this.store.eraseIntent(journal);
    await this.kernel.reconcile(ctx);
    const current = await this.kernel.operation(ctx,operationId);
    if (current.state === 'pending' && this.worker !== journal.worker) return current;
    return this.readback(ctx, journal, this.worker, current.state === 'pending');
  }
  async rename(context: TrustedContext, input: RenameInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent: AccountIntent = { kind: 'rename', operationId: input.operationId, accountRef: input.accountRef,
      expectedRevision: input.expectedRevision, displayName: input.displayName, intentDigest: '' };
    identifier(intent.operationId); uuid(intent.accountRef); revision(intent.expectedRevision); name(intent.displayName);
    intent.intentDigest = this.custody.digest({ context: ctx, intent });
    return this.kernel.beginAccount(ctx, Object.freeze(intent));
  }
  async disable(context: TrustedContext, input: DisableInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent: AccountIntent = { kind: 'disable', operationId: input.operationId, accountRef: input.accountRef,
      expectedRevision: input.expectedRevision, intentDigest: '' };
    identifier(intent.operationId); uuid(intent.accountRef); revision(intent.expectedRevision);
    intent.intentDigest = this.custody.digest({ context: ctx, intent });
    return this.kernel.beginAccount(ctx, Object.freeze(intent));
  }
  private lifecycleIntent(kind: 'suspend' | 'resume', input: SuspendInput | ResumeInput): AccountIntent {
    const intent: AccountIntent = { kind, operationId: input.operationId, accountRef: input.accountRef,
      expectedRevision: input.expectedRevision, intentDigest: '' };
    identifier(intent.operationId); uuid(intent.accountRef); revision(intent.expectedRevision);
    return intent;
  }
  async suspend(context: TrustedContext, input: SuspendInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent = this.lifecycleIntent('suspend', input);
    intent.intentDigest = this.custody.digest({ context: ctx, intent });
    return this.kernel.beginAccount(ctx, Object.freeze(intent));
  }
  private async retainedProof(ctx: TrustedContext, account: AccountStatus): Promise<ResumeCustodyAuthority | undefined> {
    try {
      if (!this.kernel.accountCustody || !this.retainedCustody || account.state !== 'suspended') return undefined;
      const identity = await this.kernel.accountCustody(ctx, account.accountRef);
      if (identity.revision !== account.revision || identity.epoch !== account.epoch) return undefined;
      const mapping = await this.store.mapping(ctx, identity.generation);
      if (!mapping || mapping.consumerId !== ctx.consumerId || mapping.accountRef !== account.accountRef ||
          mapping.ownerRef !== account.ownerRef || mapping.generation !== identity.generation ||
          mapping.descriptor.generation !== identity.generation ||
          mapping.descriptor.nativePhysicalIdentity !== identity.nativePhysicalIdentity ||
          !exactCandidate(mapping, physicalCandidate(mapping.descriptor))) return undefined;
      const proof = await this.retainedCustody.verify(mapping);
      const authKind = oauthProfileDefinition(account.profile) ? 'oauth' : 'api_key';
      if (!proof || proof.contract !== 'native-retained-custody/v1' ||
          proof.generation !== identity.generation ||
          proof.nativePhysicalIdentity !== identity.nativePhysicalIdentity ||
          proof.credentialKinds.length !== 1 || proof.credentialKinds[0] !== authKind) return undefined;
      return Object.freeze({ ...proof, metadataRevision: account.revision, authorizationEpoch: account.epoch, credentialKinds: Object.freeze([...proof.credentialKinds]) });
    } catch { return undefined; }
  }
  async lifecycle(context: TrustedContext, accountRef: string): Promise<AccountLifecycleReadback> {
    const ctx = captureContext(context); uuid(accountRef);
    const account = await this.kernel.account(ctx, accountRef);
    const authKind = oauthProfileDefinition(account.profile) ? 'oauth' : 'api_key';
    const proof = account.state === 'suspended' ? await this.retainedProof(ctx, account) : undefined;
    const current = await this.kernel.account(ctx, accountRef);
    return Object.freeze({ account: current, authKind, resumeCustody: current.state !== 'suspended' ? 'not_applicable' :
      proof && current.revision === account.revision && current.epoch === account.epoch ? 'verified' : 'attention_required' });
  }
  async resume(context: TrustedContext, input: ResumeInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent = this.lifecycleIntent('resume', input);
    intent.intentDigest = this.custody.digest({ context: ctx, intent });
    const account = await this.kernel.account(ctx, intent.accountRef!);
    const proof = await this.retainedProof(ctx, account);
    return this.kernel.beginAccount(ctx, Object.freeze(intent), proof);
  }
  async account(context: TrustedContext, ref: string): Promise<AccountStatus> {
    const ctx = captureContext(context); uuid(ref); return this.kernel.account(ctx, ref);
  }
  async retirement(context: TrustedContext, accountRef: string, operationId: string): Promise<AccountRetirementReadback> {
    const ctx = captureContext(context); uuid(accountRef); identifier(operationId);
    const readback = await this.store.retirement(ctx, accountRef, operationId);
    if (!readback) throw new KernelError('unknown');
    return readback;
  }
  async policyClosure(context: TrustedContext, operationId: string): Promise<PolicyUseClosureReadback> {
    const ctx = captureContext(context); identifier(operationId);
    const readback = await this.store.policyClosure(ctx, operationId);
    if (!readback) throw new KernelError('unknown');
    return readback;
  }
  async accounts(context: TrustedContext, query: AccountPageQuery = {}): Promise<AccountPage> {
    const ctx = captureContext(context);
    const captured = Object.freeze({ ownerRef: query.ownerRef, cursor: query.cursor, limit: query.limit,
      allowedOwnerRefs: query.allowedOwnerRefs === undefined ? undefined : Object.freeze([...query.allowedOwnerRefs]) });
    return this.kernel.accounts(ctx, captured);
  }
  async operation(context: TrustedContext, id: string): Promise<OperationStatus> {
    const ctx = captureContext(context); identifier(id);
    const operation = await this.kernel.operation(ctx, id);
    if (operation.state !== 'pending' && operation.state !== 'unknown') return operation;
    const journal = await this.store.readJournal(ctx, id);
    return journal && this.supportsOAuthProfile(journal.profile.profile) ? this.oauthReadback(ctx, journal, undefined,
      oauthProfileDefinition(journal.profile.profile)?.family !== 'claude') : operation;
  }
  async reconcile(context: TrustedContext): Promise<void> {
    const ctx = captureContext(context);
    const expired = await this.store.expire(ctx);
    for (const j of expired) await this.kernel.unknownCandidate(ctx, j.operationId, j.worker);
    await this.kernel.reconcile(ctx);
  }
  // Protected worker result, never a browser DTO. Execution jobs remain for B3.
  async cleanup(context: TrustedContext): Promise<'idle' | 'erased' | 'quarantined' | 'transport_pending'> {
    const ctx = captureContext(context);
    const claim = await this.kernel.claimCleanup(ctx, this.worker);
    if (!claim) return 'idle';
    return this.cleanupClaim(ctx, claim);
  }
  // Trusted facade dispatches an already owned kernel cleanup claim. No new lease or ledger.
  async cleanupClaim(context: TrustedContext, input: CleanupClaim): Promise<'erased' | 'quarantined' | 'transport_pending'> {
    const ctx = captureContext(context);
    const scope: CleanupClaim['scope'] = input.scope.kind === 'generation'
      ? { kind: 'generation', generation: input.scope.generation, profile: input.scope.profile,
          ...(input.scope.descriptor ? { descriptor: { generation: input.scope.descriptor.generation,
            nativePhysicalIdentity: input.scope.descriptor.nativePhysicalIdentity, profile: input.scope.descriptor.profile } } : {}) }
      : { kind: 'execution', executionRef: input.scope.executionRef, transports: [] };
    const claim = { cleanupRef: input.cleanupRef, token: input.token, scope };
    uuid(claim.cleanupRef); uuid(claim.token);
    if (claim.scope.kind === 'execution') {
      await this.kernel.settleCleanup(ctx, claim.cleanupRef, this.worker, claim.token, false);
      return 'transport_pending';
    }
    let succeeded = false;
    try {
      if (oauthProfileDefinition(claim.scope.profile)) {
        succeeded = await this.cleanupOAuth(ctx, claim.cleanupRef, claim.token, claim.scope.generation, claim.scope.profile);
        await this.kernel.settleCleanup(ctx, claim.cleanupRef, this.worker, claim.token, succeeded);
        return succeeded ? 'erased' : 'quarantined';
      }
      const mapping = await this.store.mapping(ctx, claim.scope.generation);
      const proof = claim.scope.descriptor;
      if (!mapping || !proof || claim.scope.profile !== mapping.profile.profile || proof.generation !== mapping.generation || proof.profile !== mapping.profile.profile ||
          proof.nativePhysicalIdentity !== mapping.descriptor.nativePhysicalIdentity) throw new KernelError('conflict');
      const current = await this.native.read(mapping);
      if (current.length !== 1 || !sameCandidate(mapping.descriptor, physicalCandidate(current[0]))) throw new KernelError('conflict');
      if (!await this.store.cleanupAllowed(ctx, claim.cleanupRef, this.worker, claim.token,
          mapping.generation, mapping.descriptor.nativePhysicalIdentity, mapping.profile.profile)) throw new KernelError('denied');
      try { await this.native.setState(mapping,'inactive'); } catch { /* Exact GET must prove disabled after uncertain PUT. */ }
      const inactive = await this.native.read(mapping);
      if (inactive.length !== 1 || inactive[0].state !== 'inactive' || !sameCandidate(mapping.descriptor,physicalCandidate(inactive[0]))) throw new KernelError('conflict');
      if (!await this.store.cleanupAllowed(ctx, claim.cleanupRef, this.worker, claim.token,
          mapping.generation, mapping.descriptor.nativePhysicalIdentity, mapping.profile.profile)) throw new KernelError('denied');
      await this.native.erase(mapping);
      succeeded = true;
    } catch { /* Missing/stale/ambiguous mapping never authorizes guessed erase. */ }
    await this.kernel.settleCleanup(ctx, claim.cleanupRef, this.worker, claim.token, succeeded);
    return succeeded ? 'erased' : 'quarantined';
  }
  private async cleanupOAuth(ctx: TrustedContext, cleanupRef: string, cleanupToken: string,
    generation: string, profile: string): Promise<boolean> {
    const oauth = this.oauthProviders.get(profile);
    if (!oauth?.lifecycle || !this.store.oauthCleanup) return false;
    const authority = Object.freeze({ cleanupRef, cleanupToken });
    const owned = await this.store.oauthCleanup(ctx, this.worker, authority, 'read', oauth.profile);
    if (!owned || owned.journal.generation !== generation) throw new KernelError('denied');
    const journal = owned.journal, scope = oauthScope(journal);
    if (journal.consumerId !== ctx.consumerId || !['create','reconnect'].includes(journal.purpose) ||
        journal.profile.profile !== oauth.profile.profile || journal.profile.baseURL !== oauth.profile.baseURL ||
        !oauthProfileDefinition(profile)!.cleanupModels.includes(journal.profile.model) || journal.profile.qualificationRef !== oauth.profile.qualificationRef) throw new KernelError('conflict');
    const validate = (r: OAuthCleanupReadback): PhysicalCandidate | undefined => {
      if (r.operationId !== scope.operationId || r.accountRef !== scope.accountRef ||
          typeof r.credentialsErased !== 'boolean' || !['pending','closed','unknown'].includes(r.closure) ||
          r.closure === 'closed' && !r.credentialsErased) throw new KernelError('conflict');
      const d = r.native === undefined ? undefined : physicalCandidate(r.native);
      if (d && !exactCandidate(journal, d) || owned.native && (!d || !sameCandidate(owned.native, d))) throw new KernelError('conflict');
      return d;
    };
    let result = await oauth.lifecycle.cleanup(scope, authority, 'read');
    const descriptor = validate(result);
    if (descriptor) {
      await this.store.saveMapping(Object.freeze({ ...journal, descriptor }));
      // Late custody proof only binds the original quarantined cleanup identity.
      // Current cleanup ownership does not revive the enrollment writer.
      await this.kernel.acknowledgeCandidate(ctx, journal.operationId, this.worker,
        { generation: descriptor.generation, nativePhysicalIdentity: descriptor.nativePhysicalIdentity, profile: descriptor.profile });
    }
    const fresh = await this.store.oauthCleanup(ctx, this.worker, authority, 'erase', oauth.profile, scope);
    if (!fresh || (descriptor && (!fresh.native || !sameCandidate(descriptor, fresh.native)))) throw new KernelError('denied');
    if (!result.credentialsErased) {
      try { result = await oauth.lifecycle.cleanup(scope, authority, 'erase'); }
      catch { result = await oauth.lifecycle.cleanup(scope, authority, 'read'); } // One erase, bounded same-scope recovery.
      const erased = validate(result);
      if (descriptor && (!erased || !sameCandidate(descriptor, erased)) ||
          !descriptor && erased) return false; // Newly discovered birth needs its own proof phase.
    }
    // Final committed claim read precedes kernel settlement; no HTTP awaits follow.
    if (!await this.store.oauthCleanup(ctx, this.worker, authority, 'erase', oauth.profile, scope)) return false;
    return result.credentialsErased && result.closure === 'closed';
  }
}


export interface AccountLimitsSelector {
  readonly ownerRef: string; readonly accountRef: string; readonly profileId: string;
  readonly expectedAuthorizationEpoch: number;
}
/** Trusted logical-to-physical read, with a final kernel fence after mapping I/O. */
export async function accountLimitsTarget(kernel: Pick<DurableKernel, 'accountLimitsIdentity'>,
  store: Pick<ManagementStore, 'mapping'>, ctx: TrustedContext, input: AccountLimitsSelector): Promise<PhysicalCandidate> {
  if (!kernel.accountLimitsIdentity) throw new KernelError('unavailable');
  uuid(input.accountRef); identifier(input.ownerRef); identifier(input.profileId, 64); revision(input.expectedAuthorizationEpoch);
  const current = await kernel.accountLimitsIdentity(ctx, input.accountRef);
  if (!['active','suspended'].includes(current.state) || current.ownerRef !== input.ownerRef ||
      current.profile !== input.profileId || current.epoch !== input.expectedAuthorizationEpoch)
    throw new KernelError('denied');
  const mapping = await store.mapping(ctx, current.generation);
  if (!mapping || mapping.consumerId !== ctx.consumerId || mapping.accountRef !== current.accountRef ||
      mapping.ownerRef !== current.ownerRef || mapping.profile.profile !== current.profile ||
      mapping.descriptor.nativePhysicalIdentity !== current.nativePhysicalIdentity ||
      !exactCandidate(mapping, physicalCandidate(mapping.descriptor))) throw new KernelError('denied');
  const after = await kernel.accountLimitsIdentity(ctx, input.accountRef);
  if (!['active','suspended'].includes(after.state) || after.ownerRef !== current.ownerRef ||
      after.profile !== current.profile || after.epoch !== current.epoch ||
      after.generation !== current.generation || after.nativePhysicalIdentity !== current.nativePhysicalIdentity)
    throw new KernelError('denied');
  return mapping.descriptor;
}
