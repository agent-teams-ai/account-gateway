import { KernelError, identifier, uuid, revision } from "./domain.ts";
import { exactCandidate, physicalCandidate } from "./account-management.ts";
export {
  codexOAuthProfile,
  codexOAuthCleanupModels,
  claudeOAuthProfile,
} from "./oauth-profiles.ts";
import type {
  AccountIntent,
  AccountStatus,
  DurableKernel,
  OperationStatus,
  TrustedContext,
  AccountRetirementReadback,
  PolicyUseClosureReadback,
  RetainedCustodyProof,
} from "./domain.ts";

// Private consumer-owned ports. They are not SDK DTOs or an inference authority.
export interface ManagedProfile {
  readonly profile: string;
  readonly baseURL: string;
  readonly model: string;
  // Receipt comes from trusted fixture/non-inference qualification, never ingress.
  readonly qualificationRef: string;
}
export interface CandidateScope {
  readonly consumerId: string;
  readonly operationId: string;
  readonly accountRef: string;
  readonly ownerRef: string;
  readonly purpose: "create" | "reconnect";
}
export interface PhysicalCandidate {
  readonly generation: string;
  readonly nativePhysicalIdentity: string;
  readonly nativeId: number;
  readonly createdAt: string;
  readonly profile: string;
  readonly baseURL: string;
  readonly model: string;
}
export interface NativeReadback extends PhysicalCandidate {
  readonly state: "inactive" | "active";
}
export interface CandidateJournal extends CandidateScope {
  readonly generation: string;
  readonly worker: string;
  readonly profile: ManagedProfile;
}
export interface CandidateMapping extends CandidateJournal {
  readonly descriptor: PhysicalCandidate;
}
export interface CandidateNative {
  // Each call makes at most one candidate-management HTTP request. Never inference.
  create(scope: CandidateJournal, displayName: string, apiKey: string): Promise<void>;
  read(scope: CandidateJournal): Promise<readonly NativeReadback[]>;
  setState(mapping: CandidateMapping, state: "active" | "inactive"): Promise<void>;
  erase(mapping: CandidateMapping): Promise<void>;
}
// Consumer-owned protected enrollment ports. No SDK/vendor DTOs or token data.
// Catalog evidence pins intent; it is never an account qualification receipt.
export interface OAuthScope {
  readonly consumerId: string;
  readonly operationId: string;
  readonly ownerRef: string;
  readonly accountRef: string;
  readonly generation: string;
}
export interface OAuthReadback {
  readonly operationId: string;
  readonly accountRef: string;
  // Native connect state is distinct from the completed custody outcome
  // "staged" and from the future descriptor's qualification state.
  readonly state: "prepared" | "entered" | "completed" | "expired" | "unknown";
}
export interface OAuthBeginReadback extends OAuthReadback {
  readonly authorizationURL?: string;
  readonly deviceAuthorization?: OAuthDeviceAuthorization;
}
export type OAuthMethod = "device_code" | "browser";
export interface OAuthDeviceAuthorization {
  readonly userCode: string;
  readonly verificationURL: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}
export interface OAuthEnrollmentNative {
  begin(scope: OAuthScope, method?: OAuthMethod): Promise<OAuthBeginReadback>;
  read(scope: OAuthScope): Promise<OAuthReadback>;
  complete(scope: OAuthScope, callback: OAuthCallback): Promise<OAuthReadback>;
  poll(scope: OAuthScope): Promise<OAuthReadback>;
}
export interface OAuthRefreshReadback {
  readonly operationId: string;
  readonly accountRef: string;
  readonly state: "idle" | "prepared" | "entered" | "completed" | "unknown";
  readonly refreshRef?: string;
}
export interface OAuthRefreshNative {
  // Native alone owns due time, credential version and durable attempt identity.
  refresh(scope: OAuthScope): Promise<OAuthRefreshReadback>;
}
export interface OAuthCleanupAuthority {
  readonly cleanupRef: string;
  readonly cleanupToken: string;
}
export type OAuthCleanupAction = "read" | "erase";
export interface OAuthCleanupReadback {
  readonly operationId: string;
  readonly accountRef: string;
  readonly credentialsErased: boolean;
  readonly closure: "pending" | "closed" | "unknown";
  readonly native?: PhysicalCandidate;
}
export interface OAuthLifecycleNative {
  cleanup(
    scope: OAuthScope,
    authority: OAuthCleanupAuthority,
    action: OAuthCleanupAction,
  ): Promise<OAuthCleanupReadback>;
}
export interface OAuthCleanupScope {
  readonly journal: CandidateJournal;
  readonly leaseExpiresAt: string;
  readonly native?: PhysicalCandidate;
}
export type OAuthSelectors = Pick<
  OAuthScope,
  "consumerId" | "operationId" | "accountRef" | "generation"
>;
export type OAuthDescriptor = {
  readonly operationId: string;
  readonly accountRef: string;
} & (
  | { readonly state: "staged"; readonly qualification: "pending" }
  | {
      readonly state: "qualified";
      readonly qualification: "controlled-source-v1";
      readonly native: PhysicalCandidate;
    }
);
export interface OAuthDescriptorBoundary {
  // Exact protected inert physical birth and native source qualification.
  describe(scope: OAuthScope): Promise<OAuthDescriptor>;
}
export interface OAuthEnrollmentOptions {
  readonly profile: ManagedProfile;
  readonly native: OAuthEnrollmentNative;
  readonly descriptor?: OAuthDescriptorBoundary;
  readonly lifecycle?: OAuthLifecycleNative;
  readonly refresh?: OAuthRefreshNative;
}
export type OAuthCallback =
  | { readonly state: string; readonly code: string }
  | { readonly authorizationCode: string };
export type OAuthCompleteInput = OAuthCallback & {
  readonly operationId: string;
  readonly ownerRef: string;
};
export interface OAuthBeginInput {
  readonly operationId: string;
  readonly ownerRef: string;
  readonly profile: string;
  readonly displayName: string;
  readonly method?: OAuthMethod;
}
export interface OAuthReconnectInput {
  readonly operationId: string;
  readonly accountRef: string;
  readonly expectedRevision: number;
  readonly method?: OAuthMethod;
}
export interface OAuthPollInput {
  readonly operationId: string;
  readonly ownerRef: string;
}
export interface OAuthBeginResult {
  readonly operation: OperationStatus;
  readonly authorizationURL?: string;
  readonly deviceAuthorization?: OAuthDeviceAuthorization;
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
export type ResumeCustodyState = "not_applicable" | "verified" | "attention_required";
export interface AccountLifecycleReadback {
  account: AccountStatus;
  authKind: "api_key" | "oauth";
  resumeCustody: ResumeCustodyState;
}
export interface AcceptedIntent {
  readonly context: TrustedContext;
  readonly intent: AccountIntent;
  readonly apiKey?: string;
}
export interface IntentCustody {
  digest(accepted: AcceptedIntent): string;
}
// Required read-only lifecycle attestation. Kernel execution consumers remain
// unchanged; AccountManagement delegates to this concrete store capability.
export interface AccountRetirementRead {
  retirement(
    context: TrustedContext,
    accountRef: string,
    operationId: string,
  ): Promise<AccountRetirementReadback | undefined>;
}
export interface PolicyUseClosureRead {
  policyClosure(
    context: TrustedContext,
    operationId: string,
  ): Promise<PolicyUseClosureReadback | undefined>;
}
export interface ManagementStore extends AccountRetirementRead, PolicyUseClosureRead {
  stage(scope: CandidateScope, apiKey: string): Promise<boolean>;
  journal(
    scope: CandidateScope,
    generation: string,
    worker: string,
    profile: ManagedProfile,
  ): Promise<CandidateJournal>;
  readJournal(context: TrustedContext, operationId: string): Promise<CandidateJournal | undefined>;
  credential(scope: CandidateScope): Promise<string | undefined>;
  eraseIntent(scope: CandidateScope): Promise<void>;
  saveMapping(mapping: CandidateMapping): Promise<void>;
  mapping(context: TrustedContext, generation: string): Promise<CandidateMapping | undefined>;
  cleanupAllowed(
    context: TrustedContext,
    cleanupRef: string,
    worker: string,
    token: string,
    generation: string,
    identity: string,
    profile: string,
  ): Promise<boolean>;
  expire(context: TrustedContext): Promise<readonly CandidateJournal[]>;
  // Optional for existing enrollment-only adapters; absence cannot grant refresh.
  nextOAuthRefresh?(
    context: TrustedContext,
    worker: string,
    profile: ManagedProfile,
    after?: string,
  ): Promise<CandidateMapping | undefined>;
  activeOAuthRefresh?(
    context: TrustedContext,
    worker: string,
    selectors: OAuthSelectors,
    profile: ManagedProfile,
  ): Promise<CandidateMapping | undefined>;
  pendingOAuthRefresh?(
    context: TrustedContext,
    worker: string,
    selectors: OAuthSelectors,
    profile: ManagedProfile,
  ): Promise<CandidateJournal | undefined>;
  oauthCleanup?(
    context: TrustedContext,
    worker: string,
    authority: OAuthCleanupAuthority,
    action: OAuthCleanupAction,
    profile: ManagedProfile,
    selectors?: OAuthSelectors,
  ): Promise<OAuthCleanupScope | undefined>;
}
export type CreateInput = Pick<
  AccountIntent,
  "operationId" | "ownerRef" | "profile" | "displayName"
> & { apiKey: string };
export type ReconnectInput = Pick<
  AccountIntent,
  "operationId" | "accountRef" | "expectedRevision"
> & { apiKey: string };
export type RenameInput = Pick<
  AccountIntent,
  "operationId" | "accountRef" | "expectedRevision" | "displayName"
>;
export type DisableInput = Pick<AccountIntent, "operationId" | "accountRef" | "expectedRevision">;
export type SuspendInput = Pick<AccountIntent, "operationId" | "accountRef" | "expectedRevision">;
export type ResumeInput = Pick<AccountIntent, "operationId" | "accountRef" | "expectedRevision">;

// Private port and contract entrypoint; implementations live at application edge.
export {
  AccountManagement,
  captureContext,
  exactCandidate,
  sameCandidate,
  physicalCandidate,
} from "./account-management.ts";

export interface AccountLimitsSelector {
  readonly ownerRef: string;
  readonly accountRef: string;
  readonly profileId: string;
  readonly expectedAuthorizationEpoch: number;
}
/** Trusted logical-to-physical read, with a final kernel fence after mapping I/O. */
export async function accountLimitsTarget(
  kernel: Pick<DurableKernel, "accountLimitsIdentity">,
  store: Pick<ManagementStore, "mapping">,
  ctx: TrustedContext,
  input: AccountLimitsSelector,
): Promise<PhysicalCandidate> {
  if (!kernel.accountLimitsIdentity) {
    throw new KernelError("unavailable");
  }
  uuid(input.accountRef);
  identifier(input.ownerRef);
  identifier(input.profileId, 64);
  revision(input.expectedAuthorizationEpoch);
  const current = await kernel.accountLimitsIdentity(ctx, input.accountRef);
  if (
    !["active", "suspended"].includes(current.state) ||
    current.ownerRef !== input.ownerRef ||
    current.profile !== input.profileId ||
    current.epoch !== input.expectedAuthorizationEpoch
  ) {
    throw new KernelError("denied");
  }
  const mapping = await store.mapping(ctx, current.generation);
  if (
    !mapping ||
    mapping.consumerId !== ctx.consumerId ||
    mapping.accountRef !== current.accountRef ||
    mapping.ownerRef !== current.ownerRef ||
    mapping.profile.profile !== current.profile ||
    mapping.descriptor.nativePhysicalIdentity !== current.nativePhysicalIdentity ||
    !exactCandidate(mapping, physicalCandidate(mapping.descriptor))
  ) {
    throw new KernelError("denied");
  }
  const after = await kernel.accountLimitsIdentity(ctx, input.accountRef);
  if (
    !["active", "suspended"].includes(after.state) ||
    after.ownerRef !== current.ownerRef ||
    after.profile !== current.profile ||
    after.epoch !== current.epoch ||
    after.generation !== current.generation ||
    after.nativePhysicalIdentity !== current.nativePhysicalIdentity
  ) {
    throw new KernelError("denied");
  }
  return mapping.descriptor;
}
