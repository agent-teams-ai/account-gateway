// Internal domain contracts. The HTTP slice must map the single wire authority
// at its boundary; these are neither wire validators nor public SDK exports.
export interface TrustedContext { readonly consumerId: string }
export type OperationState = 'pending' | 'applied' | 'rejected' | 'unknown';
export type Effect = 'not_dispatched' | 'dispatch_started' | 'response_started' | 'completed' | 'effect_unknown' | 'rejected_before_dispatch';
export type AccountState = 'staging' | 'active' | 'disabled' | 'quarantined';
export class KernelError extends Error {
  readonly code: 'invalid' | 'unknown' | 'conflict' | 'denied' | 'unavailable';
  constructor(code: KernelError['code']) { super(code); this.code = code; }
}
// Compare nanoseconds, including offsets and differently marshalled fractions.
// Date is used only for the whole second, never to round fractional authority.
export function instant(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 64) throw new KernelError('denied');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || value.startsWith('0000-')) throw new KernelError('denied');
  const date = new Date(match[1] + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== match[1]) throw new KernelError('denied');
  let offset = 0;
  if (match[3] !== 'Z') {
    const h = Number(match[3].slice(1, 3)), m = Number(match[3].slice(4));
    if (h > 23 || m > 59) throw new KernelError('denied');
    offset = (h * 60 + m) * (match[3][0] === '+' ? 1 : -1);
  }
  return BigInt(date.getTime() - offset * 60_000) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export interface AccountIntent {
  operationId: string;
  kind: 'create' | 'reconnect' | 'rename' | 'disable';
  // Opaque, credential-safe ingress token. Never derive this from a plain key.
  intentDigest: string;
  accountRef?: string;
  expectedRevision?: number;
  ownerRef?: string;
  profile?: string;
  displayName?: string;
}
export interface AccountStatus {
  accountRef: string; ownerRef: string; profile: string; displayName: string;
  state: AccountState; revision: number; epoch: number;
}
export type AccountRetirementState = 'pending' | 'completed' | 'rejected';
export interface AccountRetirementCounts {
  retainedGenerations: number; settledNativeErasureGenerations: number;
  retainedExecutions: number; openExecutions: number; requests: number;
  occupiedTransports: number; acknowledgedNativeTransports: number;
  positiveKernelNonEntryRequests: number; unknownEffects: number;
}
export interface AccountRetirementReadback {
  operationRef: string; account: AccountStatus; state: AccountRetirementState;
  fence: { metadataRevision: number; authorizationEpoch: number };
  counts: AccountRetirementCounts; inert: boolean;
}
export type PolicyUseClosureCounts = Pick<AccountRetirementCounts, 'retainedExecutions' | 'openExecutions' | 'requests' |
  'occupiedTransports' | 'acknowledgedNativeTransports' | 'positiveKernelNonEntryRequests' | 'unknownEffects'>;
export interface PolicyUseClosureReadback {
  operationRef: string; policySubject: string; policyRevision: number;
  state: 'pending' | 'completed'; counts: PolicyUseClosureCounts; closed: boolean;
}
export interface AccountPageQuery {
  ownerRef?: string; cursor?: string; limit?: number;
  // Internal authority filter: at most 100 owners; an empty set selects no rows.
  allowedOwnerRefs?: readonly string[];
}
export interface AccountPage { accounts: readonly AccountStatus[]; nextCursor?: string }
export interface OperationStatus {
  operationRef: string; state: OperationState; code?: string;
  accountRef?: string; executionRef?: string; revision?: number; epoch?: number;
  deadline?: string;
}
// Protected-private proof. An actual native adapter must qualify the physical
// identity mechanism before accepting this proof. Never send it in a safe DTO.
export interface NativeDescriptor {
  generation: string; nativePhysicalIdentity: string; profile: string;
}
export interface NativeCreatePermit { operationRef: string; candidate: string; profile: string }
export interface ApprovedPreparation {
  operationId: string; intentDigest: string; invocationRef: string; attemptRef: string;
  permittedAccounts: readonly string[]; profile: string;
  policySubject: string; policyRevision: number; bindingRevision: number; issuerEpoch: string;
  // Supplied only by trusted server policy, never extended by the client.
  deadline: Date; limits: ApprovedLimits;
}
// Server-approved policy values, independent of SDK validation and provider DTOs.
export interface ApprovedLimits {
  requests: number; concurrency: number; requestBytes: number; outputBytes: number; tokens: number;
}
export interface ExecutionStatus {
  executionRef: string; accountRef: string; epoch: number;
  state: 'open' | 'closed' | 'fenced'; deadline: string;
}
export interface PrivateAdmission {
  executionRef: string; issuerEpoch: string;
  invocationRef: string; attemptRef: string; accountRef: string; authorizationEpoch: number;
  subjectRef: string; policyRevision: number; bindingRevision: number; profileId: string;
  limits: ApprovedLimits; expiresAt: string;
}
// Private persisted read authority for the HTTP/native boundary. This does not
// grant dispatch: claim remains the sole atomic permission decision.
export interface SavedExecution {
  readonly admission: PrivateAdmission;
  readonly generation: string;
  readonly state: ExecutionStatus['state'];
  readonly dispatchAllowed: boolean;
}
export interface ExecutionRead {
  savedExecution(context: TrustedContext, executionRef: string): Promise<SavedExecution>;
  currentWorkerLease(context: TrustedContext, worker: string): Promise<string>;
  // Read an already claimed execution cleanup lease, without renewal/creation.
  currentCleanupLease(context: TrustedContext, cleanupRef: string, worker: string, token: string): Promise<string>;
  requestProof(context: TrustedContext, executionRef: string, requestId: string): Promise<NativeDispatchProof | undefined>;
}
export interface RequestStatus { requestRef: string; effect: Effect; code?: string }
// Trusted authenticated native callback input. Never obtain this authority from
// an execution client's payload or caller-selected URL. Actual process enrollment
// and incarnation authentication remain B3 composition gates.
export interface NativeReservation {
  originRef: string; engineIncarnation: string; requestNonce: string;
}
export interface NativeBinding extends NativeReservation { generation: string }
// Protected-private permanent one-request proof. A missing token or native
// binding denotes legacy occupancy without closure authority.
export interface TransportClosure {
  executionRef: string; requestRef: string; worker: string; token?: string; native?: NativeBinding;
}
// The sole first claim returns this bound dispatch/closure identity. Cleanup
// may read it under its existing lease/CAS but never receives dispatch permission.
export interface NativeDispatchProof extends TransportClosure {
  token: string; native: NativeBinding;
}
export interface CleanupAuthority {
  cleanupRef: string; token: string;
  // Required on delegated wire ACKs; trusted physical retirement has no wire lease.
  leaseExpiresAt?: string;
}
export type ClaimResult =
  | { status: RequestStatus; dispatch?: never }
  | { status: RequestStatus; dispatch: { descriptor: NativeDescriptor; executionRef: string; requestRef: string;
      limits: ApprovedLimits; deadline: string; closure: NativeDispatchProof } };
// Without a descriptor, only exact-generation readback/quarantine is allowed;
// never delete a guessed native identity. Settlement is a trusted adapter ack.
export interface CleanupClaim {
  cleanupRef: string; token: string;
  scope: { kind: 'generation'; generation: string; profile: string; descriptor?: NativeDescriptor } | { kind: 'execution'; executionRef: string; transports: readonly TransportClosure[] };
}
export interface Bounds {
  // maxConcurrent also caps occupied local transports per consumer/account.
  maxRequests: number; maxConcurrent: number; maxRequestBytes: number; maxOutputBytes: number; maxTokens: number; maxRunMs: number;
  workerLeaseMs: number; cleanupLeaseMs: number; maintenanceBatch: number;
}
// Aggregate facts include prepaid, single-use closure/fence/disable slots and
// bounded worker/issuer recovery slots. These are conservative implementation
// defaults, not measured D-final capacity qualifications. Accepted authority and
// effect facts are never evicted or refunded. Expired workers without any durable
// work reference may release a prepaid slot and later enroll again; the incoming
// expired UUID cannot renew itself. Referenced workers and issuer history persist.
export interface DurableFactBounds {
  maxServiceFacts: number; maxConsumerFacts: number; maxAccountFacts: number;
  workerSlots: number; issuerSlots: number;
}
export const factDefaults: Readonly<DurableFactBounds> = Object.freeze({
  maxServiceFacts: 1_000_000, maxConsumerFacts: 100_000, maxAccountFacts: 10_000,
  workerSlots: 16, issuerSlots: 32,
});
export function boundedFacts(input: DurableFactBounds): Readonly<DurableFactBounds> {
  const caps: DurableFactBounds = { maxServiceFacts: 100_000_000, maxConsumerFacts: 10_000_000,
    maxAccountFacts: 1_000_000, workerSlots: 1_024, issuerSlots: 1_024 };
  if (!input || typeof input !== 'object' || Object.keys(input).length !== Object.keys(caps).length ||
      Object.keys(input).some(key => !Object.hasOwn(caps, key))) throw new KernelError('invalid');
  for (const key of Object.keys(caps) as (keyof DurableFactBounds)[]) integer(input[key], caps[key]);
  if (input.maxAccountFacts > input.maxConsumerFacts || input.maxConsumerFacts > input.maxServiceFacts ||
      1 + input.workerSlots + input.issuerSlots > input.maxConsumerFacts) throw new KernelError('invalid');
  return Object.freeze({ ...input });
}
export const defaults: Readonly<Bounds> = Object.freeze({
  // One run holds a single execution, so this must cover the largest multi-batch review; boundedConfig keeps the hard ceiling.
  maxRequests: 640, maxConcurrent: 1, maxRequestBytes: 1_048_576, maxOutputBytes: 4_194_304, maxTokens: 100_000, maxRunMs: 3_600_000,
  workerLeaseMs: 30_000, cleanupLeaseMs: 30_000, maintenanceBatch: 100,
});
export function integer(value: unknown, max = 2_147_483_647): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new KernelError('invalid');
}
export function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new KernelError('invalid');
}
export function approvedLimits(input: ApprovedLimits, bounds: Readonly<Bounds>): ApprovedLimits {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 5 ||
      Object.keys(input).some(key => !['requests','concurrency','requestBytes','outputBytes','tokens'].includes(key))) throw new KernelError('invalid');
  integer(input.requests, bounds.maxRequests); integer(input.concurrency, bounds.maxConcurrent);
  integer(input.requestBytes, bounds.maxRequestBytes); integer(input.outputBytes, bounds.maxOutputBytes);
  integer(input.tokens, bounds.maxTokens);
  if (input.concurrency > input.requests) throw new KernelError('invalid');
  return { requests: input.requests, concurrency: input.concurrency, requestBytes: input.requestBytes,
    outputBytes: input.outputBytes, tokens: input.tokens };
}
export function boundedConfig(input: Bounds): Readonly<Bounds> {
  const caps: Bounds = { maxRequests: 10_000, maxConcurrent: 128, maxRequestBytes: 16_777_216,
    maxOutputBytes: 67_108_864, maxTokens: 10_000_000, maxRunMs: 86_400_000,
    workerLeaseMs: 300_000, cleanupLeaseMs: 300_000, maintenanceBatch: 1_000 };
  if (!input || typeof input !== 'object' || Object.keys(input).length !== Object.keys(caps).length ||
      Object.keys(input).some(key => !Object.hasOwn(caps, key))) throw new KernelError('invalid');
  for (const key of Object.keys(caps) as (keyof Bounds)[]) integer(input[key], caps[key]);
  if (input.maxConcurrent > input.maxRequests) throw new KernelError('invalid');
  return Object.freeze({ ...input });
}
export function identifier(value: unknown, max = 128): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(value) || value.length > max) throw new KernelError('invalid');
}
export function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new KernelError('invalid');
}
// All methods return a Promise, including rejection for invalid runtime input.
// Pure configuration validation and construction remain synchronous.
export interface DurableKernel {
  issuer(context: TrustedContext): Promise<string>;
  account(context: TrustedContext, accountRef: string): Promise<AccountStatus>;
  accounts(context: TrustedContext, query?: AccountPageQuery): Promise<AccountPage>;
  operation(context: TrustedContext, operationId: string): Promise<OperationStatus>;
  beginAccount(context: TrustedContext, intent: AccountIntent): Promise<OperationStatus>;
  startCandidate(context: TrustedContext, operationId: string, worker: string): Promise<NativeCreatePermit | undefined>;
  acknowledgeCandidate(context: TrustedContext, operationId: string, worker: string, proof: NativeDescriptor): Promise<OperationStatus>;
  unknownCandidate(context: TrustedContext, operationId: string, worker: string): Promise<OperationStatus>;
  prepare(context: TrustedContext, approval: ApprovedPreparation): Promise<OperationStatus>;
  execution(context: TrustedContext, executionRef: string): Promise<ExecutionStatus>;
  claim(context: TrustedContext, executionRef: string, requestId: string, worker: string, admission: PrivateAdmission, reservation: NativeReservation): Promise<ClaimResult>;
  request(context: TrustedContext, executionRef: string, requestId: string): Promise<RequestStatus>;
  effect(context: TrustedContext, executionRef: string, requestId: string, worker: string, next: Exclude<Effect, 'not_dispatched' | 'dispatch_started' | 'rejected_before_dispatch'>): Promise<RequestStatus>;
  // Only authenticated native non-entry evidence can settle a started claim.
  // Rejection spends its allowance and retains occupancy until separate closure.
  // Expired ownership commits unknown/fenced status instead of rolling it back.
  rejectBeforeDispatch(context: TrustedContext, worker: string, proof: NativeDispatchProof, entered: false): Promise<RequestStatus>;
  // Trusted transport/supervisor closure evidence, never timeout or key erasure.
  // Original owner can ack after expiry; delegation requires exact cleanup CAS.
  acknowledgeTransportClosed(context: TrustedContext, worker: string, proof: TransportClosure, cleanup?: CleanupAuthority): Promise<void>;
  fence(context: TrustedContext, operationId: string, subject: string, revision: number): Promise<OperationStatus>;
  close(context: TrustedContext, operationId: string, executionRef: string): Promise<OperationStatus>;
  heartbeat(context: TrustedContext, worker: string): Promise<void>;
  reconcile(context: TrustedContext): Promise<void>;
  restore(context: TrustedContext, expectedIssuer: string, freshIssuer: string): Promise<void>;
  claimCleanup(context: TrustedContext, worker: string): Promise<CleanupClaim | undefined>;
  cleanupTransports(context: TrustedContext, cleanupRef: string, worker: string, token: string): Promise<readonly TransportClosure[]>;
  settleCleanup(context: TrustedContext, cleanupRef: string, worker: string, token: string, succeeded: boolean): Promise<void>;
}
