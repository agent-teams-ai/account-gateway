// Pure projections of persisted SQL rows and native dispatch evidence.
// No SQL driver, connection, transaction, HTTP, or framework dependency.
import { KernelError, identifier, uuid } from "./domain.ts";
import type {
  AccountStatus,
  OperationStatus,
  ExecutionStatus,
  Effect,
  NativeDescriptor,
  NativeBinding,
  NativeReservation,
  NativeDispatchProof,
  TransportClosure,
  ApprovedLimits,
  RequestStatus,
} from "./domain.ts";

// Scalar shapes follow SQL001/002/003/005/007 and pg's default parsers:
// UUID/text -> string, int8 -> string, timestamptz -> Date. JSON stays unknown.
export type AccountRow = {
  ref: string;
  owner_ref: string;
  profile: string;
  display_name: string;
  state: AccountStatus["state"];
  revision: number;
  epoch: number;
  active_generation: string | null;
};
export type OperationRow = {
  id: string;
  state: OperationStatus["state"];
  code: string | null;
  account_ref: string | null;
  execution_ref: string | null;
  revision: number | null;
  epoch: number | null;
  deadline: Date | null;
  intent: unknown;
  lifecycle_result: unknown;
};
export type CandidateRow = {
  generation: string;
  account_ref: string;
  operation_id: string;
  profile: string;
  expected_revision: number;
  expected_epoch: number;
  old_generation: string | null;
  native_identity: string | null;
  worker: string | null;
  state: "staged" | "creating" | "ready" | "quarantined" | "retired";
};
export type ExecutionRow = {
  ref: string;
  invocation: string;
  attempt_ref: string;
  account_ref: string;
  account_epoch: number;
  profile: string;
  generation: string;
  policy_subject: string;
  policy_revision: string;
  binding_revision: string;
  issuer: string;
  policy_fence: string;
  deadline: Date;
  max_requests: number;
  max_concurrent: number;
  max_request_bytes: number;
  max_output_bytes: number;
  max_tokens: number;
  request_count: number;
  state: ExecutionStatus["state"];
  request_details_retired_at: Date | null;
};
export type RequestRow = {
  execution_ref: string;
  id: string;
  effect: Effect;
  code: string | null;
  worker: string | null;
  closure_token: string | null;
  native_origin_ref: string | null;
  engine_incarnation: string | null;
  request_nonce: string | null;
  descriptor_generation: string | null;
};
export type FenceRow = { revision: string; fence: string };
export type CleanupRow = {
  ref: string;
  generation: string | null;
  execution_ref: string | null;
  state: "pending" | "claimed" | "done";
  worker: string | null;
  token: string | null;
};
type NativeRow = Pick<
  RequestRow,
  "native_origin_ref" | "engine_incarnation" | "request_nonce" | "descriptor_generation"
>;
export type TransportRow = NativeRow &
  Pick<RequestRow, "execution_ref" | "id" | "worker" | "closure_token">;
type DescriptorRow = { generation: string; native_identity: string | null; profile: string | null };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const record = (value: unknown): value is Record<string, unknown> =>
  object(value) && !Array.isArray(value);

// SQL007 only binds accountRef; JSON is not a typed SQL row contract. Return
// whitelisted fields and refuse malformed persisted snapshots without details.
const lifecycle = (r: OperationRow): OperationStatus["lifecycle"] => {
  if (r.lifecycle_result === null) {
    return;
  }
  const intent = r.intent,
    a = r.lifecycle_result;
  if (
    !record(intent) ||
    !record(a) ||
    (intent.kind !== "suspend" && intent.kind !== "resume") ||
    typeof intent.expectedRevision !== "number" ||
    !Number.isSafeInteger(intent.expectedRevision) ||
    intent.expectedRevision < 0 ||
    typeof a.accountRef !== "string" ||
    a.accountRef !== r.account_ref ||
    typeof a.ownerRef !== "string" ||
    a.ownerRef.length < 1 ||
    Array.from(a.ownerRef).length > 128 ||
    typeof a.profile !== "string" ||
    a.profile.length < 1 ||
    Array.from(a.profile).length > 64 ||
    typeof a.displayName !== "string" ||
    Array.from(a.displayName).length > 160 ||
    (a.state !== "staging" &&
      a.state !== "active" &&
      a.state !== "suspended" &&
      a.state !== "disabled" &&
      a.state !== "quarantined") ||
    typeof a.revision !== "number" ||
    !Number.isSafeInteger(a.revision) ||
    a.revision < 1 ||
    typeof a.epoch !== "number" ||
    !Number.isSafeInteger(a.epoch) ||
    a.epoch < 1
  ) {
    throw new KernelError("unavailable");
  }
  return {
    kind: intent.kind,
    expectedRevision: intent.expectedRevision,
    account: {
      accountRef: a.accountRef,
      ownerRef: a.ownerRef,
      profile: a.profile,
      displayName: a.displayName,
      state: a.state,
      revision: a.revision,
      epoch: a.epoch,
    },
  };
};
export const operationStatus = (r: OperationRow): OperationStatus => {
  const saved = lifecycle(r);
  return {
    operationRef: r.id,
    state: r.state,
    ...(r.code !== null && r.code !== "" ? { code: r.code } : {}),
    ...(r.account_ref !== null && r.account_ref !== "" ? { accountRef: r.account_ref } : {}),
    ...(r.execution_ref !== null && r.execution_ref !== ""
      ? { executionRef: r.execution_ref }
      : {}),
    ...(r.revision !== null && r.revision !== 0 ? { revision: r.revision } : {}),
    ...(r.epoch !== null && r.epoch !== 0 ? { epoch: r.epoch } : {}),
    ...(r.deadline !== null ? { deadline: r.deadline.toISOString() } : {}),
    ...(record(r.intent) && r.intent.oauthMethod === "device_code"
      ? { oauthMethod: "device_code" }
      : {}),
    ...(saved === undefined ? {} : { lifecycle: saved }),
  };
};
export const requestStatus = (r: Pick<RequestRow, "id" | "effect" | "code">): RequestStatus => ({
  requestRef: r.id,
  effect: r.effect,
  ...(r.code !== null && r.code !== "" ? { code: r.code } : {}),
});
export const descriptor = (r: DescriptorRow): NativeDescriptor => {
  if (r.native_identity === null || r.profile === null) {
    throw new KernelError("unavailable");
  }
  return {
    generation: r.generation,
    nativePhysicalIdentity: r.native_identity,
    profile: r.profile,
  };
};
export const accountStatus = (r: AccountRow): AccountStatus => ({
  accountRef: r.ref,
  ownerRef: r.owner_ref,
  profile: r.profile,
  displayName: r.display_name,
  state: r.state,
  revision: r.revision,
  epoch: r.epoch,
});
export const executionLimits = (
  r: Pick<
    ExecutionRow,
    "max_requests" | "max_concurrent" | "max_request_bytes" | "max_output_bytes" | "max_tokens"
  >,
): ApprovedLimits => ({
  requests: r.max_requests,
  concurrency: r.max_concurrent,
  requestBytes: r.max_request_bytes,
  outputBytes: r.max_output_bytes,
  tokens: r.max_tokens,
});
const nativeBinding = (r: NativeRow): NativeBinding => {
  if (
    r.native_origin_ref === null ||
    r.engine_incarnation === null ||
    r.request_nonce === null ||
    r.descriptor_generation === null
  ) {
    throw new KernelError("unavailable");
  }
  return {
    originRef: r.native_origin_ref,
    engineIncarnation: r.engine_incarnation,
    requestNonce: r.request_nonce,
    generation: r.descriptor_generation,
  };
};
export const transportClosure = (r: TransportRow): TransportClosure => {
  if (r.worker === null) {
    throw new KernelError("unavailable");
  }
  return {
    executionRef: r.execution_ref,
    requestRef: r.id,
    worker: r.worker,
    ...(r.closure_token !== null && r.closure_token !== "" ? { token: r.closure_token } : {}),
    ...(r.native_origin_ref !== null ? { native: nativeBinding(r) } : {}),
  };
};
export const captureReservation = (input: unknown): NativeReservation => {
  if (!object(input)) {
    throw new KernelError("invalid");
  }
  const { originRef, engineIncarnation, requestNonce } = input;
  identifier(originRef);
  uuid(engineIncarnation);
  uuid(requestNonce);
  return { originRef, engineIncarnation, requestNonce };
};
export const captureClosure = (proof: unknown): TransportClosure => {
  if (!object(proof)) {
    throw new KernelError("invalid");
  }
  const native = proof.native;
  const { executionRef, requestRef, worker, token } = proof;
  uuid(executionRef);
  identifier(requestRef);
  uuid(worker);
  if (token !== undefined) {
    uuid(token);
  }
  if (native === undefined) {
    return { executionRef, requestRef, worker, token };
  }
  const reservation = captureReservation(native);
  if (!object(native)) {
    throw new KernelError("invalid");
  }
  const generation = native.generation;
  uuid(generation);
  return { executionRef, requestRef, worker, token, native: { ...reservation, generation } };
};
export function validateNativeClosure(
  proof: TransportClosure,
): asserts proof is NativeDispatchProof {
  uuid(proof.executionRef);
  identifier(proof.requestRef);
  uuid(proof.worker);
  uuid(proof.token);
  uuid(proof.native?.generation);
  // Native fields were independently validated by captureReservation. A legacy
  // NULL binding has no authority, even when an older closure token exists.
}
export const dispatchProof = (r: TransportRow): NativeDispatchProof => {
  if (r.worker === null || r.closure_token === null) {
    throw new KernelError("unavailable");
  }
  return {
    executionRef: r.execution_ref,
    requestRef: r.id,
    worker: r.worker,
    token: r.closure_token,
    native: nativeBinding(r),
  };
};
export const validateOAuthMethod = (method: unknown): void => {
  if (method !== undefined && method !== "device_code") {
    throw new KernelError("invalid");
  }
};
export const retainedContract = (contract: unknown): boolean =>
  contract === "native-retained-custody/v1";
export const requireNonEntry = (entered: unknown): void => {
  if (entered !== false) {
    throw new KernelError("invalid");
  }
};

// Capture arrays through unknown so Array.isArray cannot turn typed elements
// into any. Their different bounds and validators remain explicit local policy.
export const captureOwnerRefs = (value: unknown): readonly string[] | null => {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new KernelError("invalid");
  }
  const copy: string[] = [];
  for (const element of value) {
    const owner: unknown = element;
    identifier(owner);
    copy.push(owner);
  }
  return Object.freeze(copy);
};
export const capturePermittedAccounts = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new KernelError("invalid");
  }
  const copy: string[] = [];
  for (const element of value) {
    const ref: unknown = element;
    uuid(ref);
    copy.push(ref);
  }
  return copy;
};
