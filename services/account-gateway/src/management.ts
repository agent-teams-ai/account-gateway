import { KernelError, identifier, uuid, revision } from './domain.ts';
import type { AccountIntent, AccountPage, AccountPageQuery, AccountStatus, DurableKernel,
  OperationStatus, TrustedContext, CleanupClaim } from './domain.ts';

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
export interface ControlledProof {
  // Trusted qualified inert readback; MUST NOT probe a provider or compare tokens.
  verify(scope: CandidateJournal, descriptor: PhysicalCandidate): Promise<boolean>;
}
export interface AcceptedIntent {
  readonly context: TrustedContext; readonly intent: AccountIntent; readonly apiKey?: string;
}
export interface IntentCustody {
  digest(accepted: AcceptedIntent): string;
}
export interface ManagementStore {
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
}
export type CreateInput = Pick<AccountIntent, 'operationId' | 'ownerRef' | 'profile' | 'displayName'> & { apiKey: string };
export type ReconnectInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision'> & { apiKey: string };
export type RenameInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision' | 'displayName'>;
export type DisableInput = Pick<AccountIntent, 'operationId' | 'accountRef' | 'expectedRevision'>;

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
  private readonly worker: string;
  private readonly profiles: ReadonlyMap<string, ManagedProfile>;
  constructor(options: { kernel: DurableKernel; store: ManagementStore; custody: IntentCustody;
    native: CandidateNative; proof: ControlledProof; worker: string; profiles: readonly ManagedProfile[] }) {
    uuid(options.worker);
    if (!options.profiles.length || options.profiles.length > 128) throw new KernelError('invalid');
    const profiles = new Map<string, ManagedProfile>();
    for (const source of options.profiles) {
      const p = Object.freeze({ profile: source.profile, baseURL: source.baseURL, model: source.model,
        qualificationRef: source.qualificationRef });
      identifier(p.profile, 64); identifier(p.qualificationRef);
      physicalCandidate({ generation: options.worker, nativePhysicalIdentity: options.worker, nativeId: 1,
        createdAt: '2000-01-01T00:00:00Z', ...p });
      if (profiles.has(p.profile)) throw new KernelError('invalid');
      profiles.set(p.profile, p);
    }
    this.kernel = options.kernel; this.store = options.store; this.custody = options.custody;
    this.native = options.native; this.proof = options.proof; this.worker = options.worker; this.profiles = profiles;
  }
  async create(context: TrustedContext, input: CreateInput): Promise<OperationStatus> {
    const ctx = captureContext(context);
    const intent: AccountIntent = { kind: 'create', operationId: input.operationId, ownerRef: input.ownerRef,
      profile: input.profile, displayName: input.displayName, intentDigest: '' };
    const apiKey = input.apiKey;
    identifier(intent.operationId); identifier(intent.ownerRef); identifier(intent.profile, 64);
    name(intent.displayName); key(apiKey);
    if (!this.profiles.has(intent.profile)) throw new KernelError('invalid');
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
  private async readback(ctx: TrustedContext, journal: CandidateJournal, worker = journal.worker, activate = true): Promise<OperationStatus> {
    try {
      const candidates = await this.native.read(journal);
      if (candidates.length !== 1 || !['inactive','active'].includes(candidates[0].state)) throw new KernelError('conflict');
      const descriptor = physicalCandidate(candidates[0]);
      if (!exactCandidate(journal, descriptor)) throw new KernelError('conflict');
      const existing = await this.store.mapping(ctx,journal.generation);
      // An unexplained already-active row is not inert staging proof. Only a
      // persisted mapping from qualified staging permits activation recovery.
      if (candidates[0].state === 'active' && (!existing || !sameCandidate(existing.descriptor,descriptor))) throw new KernelError('conflict');
      if (candidates[0].state === 'inactive' && !await this.proof.verify(journal, descriptor)) throw new KernelError('conflict');
      const mapping = Object.freeze({ ...journal, descriptor });
      await this.store.saveMapping(mapping); // Durable binding/proof receipt precedes native activation and kernel promotion.
      if (activate && candidates[0].state === 'inactive') {
        try { await this.native.setState(mapping,'active'); } catch { /* ACK loss: only exact readback, never HTTP retry. */ }
        const active = await this.native.read(journal);
        if (active.length !== 1 || active[0].state !== 'active' || !sameCandidate(descriptor,physicalCandidate(active[0]))) throw new KernelError('conflict');
      }
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
  async account(context: TrustedContext, ref: string): Promise<AccountStatus> {
    const ctx = captureContext(context); uuid(ref); return this.kernel.account(ctx, ref);
  }
  async accounts(context: TrustedContext, query: AccountPageQuery = {}): Promise<AccountPage> {
    const ctx = captureContext(context);
    const captured = Object.freeze({ ownerRef: query.ownerRef, cursor: query.cursor, limit: query.limit,
      allowedOwnerRefs: query.allowedOwnerRefs === undefined ? undefined : Object.freeze([...query.allowedOwnerRefs]) });
    return this.kernel.accounts(ctx, captured);
  }
  async operation(context: TrustedContext, id: string): Promise<OperationStatus> {
    const ctx = captureContext(context); identifier(id); return this.kernel.operation(ctx, id);
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
}
