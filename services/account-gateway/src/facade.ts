import { oauthProfileDefinition } from "./oauth-profiles.ts";
import {
  executionUsageBase,
  reportUsageObservationFailure,
  nativeUsage,
  nativeUsageObservation,
  ResponsesUsageCapture,
  type NativeUsage,
  type UsageJournal,
} from "./usage.ts";
import { createServer } from "node:http";
import {
  ServiceCapacityError,
  facadeControlRoute,
  facadeBoundedReadRoute,
  inServiceLane,
} from "./service-admission.ts";
import type { ServiceAdmission } from "./service-admission.ts";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import * as c from "@agent-teams/account-gateway/contracts";
import { secretSubmission } from "@agent-teams/account-gateway/http";
import {
  AccountsLimitedError,
  FactCapacityError,
  KernelError,
  identifier,
  uuid,
} from "./domain.ts";
import type {
  AccountStatus,
  ApprovedLimits,
  ClaimResult,
  DurableKernel,
  ExecutionRead,
  NativeDispatchProof,
  OperationStatus,
  RequestStatus,
  SavedExecution,
  TrustedContext,
  CleanupAuthority,
} from "./domain.ts";
import {
  accountLimitsTarget,
  captureContext,
  physicalCandidate,
  sameCandidate,
  type AccountManagement,
  type ManagementStore,
  type PhysicalCandidate,
} from "./management.ts";
import { providerConnectionDefinition } from "./provider-connections.ts";
import {
  projectProviderConnections,
  projectProviderConnectionsV1,
  projectNativeConnectionsV2,
  compatibleLegacyConnection,
} from "./provider-connection-capabilities.ts";
import type { ProviderConnectionSource } from "./provider-connection-capabilities.ts";
import { strictJSON, validateResponses } from "./facade-ingress.ts";
import { readCachedAccountLimits } from "./limits-port.ts";
import { AccountInfoReader } from "./account-info-port.ts";
import type { AdmissionLimits, AdmissionLimitsScreen } from "./admission-limits.ts";
import {
  configuredAccountModelSource,
  readAccountModels,
  accountModelAdmission,
  readAccountModelsV2,
  accountModelAdmissionV2,
} from "./models-port.ts";
import type { AccountModelsSource, AccountModelsV2Source } from "./models-port.ts";
import type { NativeConnectionProfile } from "./provider-connections.ts";
import type { LegacyConnectionKind } from "./connection-domain.ts";
import { parse, type Schema } from "./facade-contract-parse.ts";
import {
  FacadeBearers,
  permitsOwner,
  permitsProfile,
  permitsOAuthProfile,
  savedCopy,
  sameSaved,
  type Grant,
} from "./facade-bearers.ts";
export { FacadeBearers, RUN_CONTROL_MAX_RUN_MS } from "./facade-bearers.ts";
export type {
  PreparationPolicy,
  ManagementBearer,
  ExecutionBearer,
  RunControlBearer,
  ConsumerControlBearer,
  ConfiguredBearer,
} from "./facade-bearers.ts";

// Re-export the single wire authority to private composition/configuration.
export const lifecycleContract = c.LIFECYCLE_CAPABILITY_CONTRACT;
export interface RunAccess {
  readonly operation: c.Operation;
  readonly bearer: string;
  readonly admission: c.Admission;
}
function nonempty(value: string | undefined): value is string {
  return Boolean(value);
}
function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
// The facade's own step when it cuts a stream after its 200 headers. A stop in
// the transport body or settlement already has its transport line, so pulling
// the next chunk and a settlement that is not completed get no phase here.
type StreamRelayPhase = "relay_chunk" | "relay_write" | "relay_terminal";
// Local on purpose: the facade boundary may not import transport diagnostics.
// Only the closed phase, kernel code and request reference leave the process.
function emitStreamRelayFailure(
  phase: StreamRelayPhase,
  error: unknown,
  requestRef: string | undefined,
): void {
  try {
    console.error(
      JSON.stringify({
        event: "gateway_facade_stream_failure",
        phase,
        ...(error instanceof KernelError ? { kernel_code: error.code } : {}),
        ...(requestRef === undefined ? {} : { request_ref: requestRef }),
      }),
    );
  } catch {
    /* Diagnostics never replace the abort or the unknown effect. */
  }
}
export interface NativeEnrollment {
  readonly originRef: string;
  readonly engineIncarnation: string;
  readonly worker: string;
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
  usage?(proof: NativeDispatchProof, usage: NativeUsage): Promise<void>;
  effect(
    proof: NativeDispatchProof,
    next: "response_started" | "completed" | "effect_unknown",
  ): Promise<RequestStatus>;
  rejectBeforeDispatch(proof: NativeDispatchProof, entered: false): Promise<RequestStatus>;
  closed(proof: NativeDispatchProof, cleanup?: CleanupAuthority): Promise<void>;
}
export interface NativeTransport {
  // One request/reservation, no retry. Payload is unchanged; Go alone applies
  // approved cap normalization and native SSE/tool conversion.
  request(input: {
    readonly context: TrustedContext;
    readonly saved: SavedExecution;
    readonly requestId: string;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
    readonly callback: NativeCallback;
  }): Promise<
    | { readonly kind: "status" }
    | { readonly kind: "stream"; readonly body: AsyncIterable<Uint8Array>; cancel(): Promise<void> }
  >;
  // Only exact persisted closure proof/current cleanup lease can reach native.
  cancel?(
    context: TrustedContext,
    proof: NativeDispatchProof,
    cleanup: CleanupAuthority,
  ): Promise<void>;
}
export interface FacadeOptions {
  readonly accountInfo?: AccountInfoReader;
  readonly providerConnections?: ProviderConnectionSource;
  readonly accountModels?: AccountModelsSource;
  readonly accountModelsV2?: AccountModelsV2Source;
  readonly accountLimits?: {
    getAccountLimitsCapabilities(): Promise<c.AccountLimitsCapabilities>;
    readAccountLimits(input: c.AccountLimitsRequest): Promise<c.AccountLimits>;
  };
  readonly accountLimitsRefresh?: {
    getAccountLimitsRefreshCapabilities(): Promise<c.AccountLimitsRefreshCapabilities>;
    refreshAccountLimits(input: c.AccountLimitsRequest): Promise<c.AccountLimits>;
  };
  readonly accountLimitsV2?: {
    getAccountLimitsCapabilities(): Promise<c.AccountLimitsV2Capabilities>;
    readAccountLimits(input: c.AccountLimitsRequest): Promise<c.AccountLimitsV2>;
  };
  readonly accountLimitsV3?: {
    getAccountLimitsCapabilities(): Promise<c.AccountLimitsV3Capabilities>;
    readAccountLimits(input: c.AccountLimitsRequest): Promise<c.AccountLimitsV3>;
  };
  // Native limits observed at preparation; exhausted accounts are skipped.
  readonly admissionLimits?: AdmissionLimits;
  readonly usage?: UsageJournal;
  readonly admission?: ServiceAdmission;
  readonly controlOnly?: boolean;
  readonly kernel: DurableKernel & ExecutionRead;
  readonly management: AccountManagement;
  readonly store: Pick<ManagementStore, "mapping">;
  readonly bearers: FacadeBearers;
  readonly profiles: readonly {
    readonly dto: c.Profile;
    readonly maxOutputTokens: number;
    readonly limits?: Readonly<ApprovedLimits>;
    readonly nativeProfile?: NativeConnectionProfile;
  }[];
  readonly intentHmacKey: Uint8Array;
  readonly enrollment?: NativeEnrollment;
  readonly transport?: NativeTransport;
  readonly ingressBytes?: number;
  readonly timeoutMs?: number;
  readonly bufferBytes?: number;
  // Compatible readers remain available after writes close; omission disables
  // new lifecycle writes without hiding existing suspended rows or receipts.
  readonly lifecycle?: {
    readonly contract: typeof c.LIFECYCLE_CAPABILITY_CONTRACT;
    readonly writeGate: "enabled" | "disabled";
  };
}
import {
  safe,
  requestDTO,
  accountDTO,
  lifecycleAccountDTO,
  lifecycleAccountV3DTO,
  retirementDTO,
  executionState,
} from "./facade-wire.ts";
import { singleton, body, send } from "./facade-http-boundary.ts";
export { cancelFacadeTransport } from "./facade-transport-cancel.ts";

export function createFacade(options: FacadeOptions): Server {
  const accountInfo = options.accountInfo ?? new AccountInfoReader();
  const admission = options.admission,
    controlOnly = options.controlOnly === true;
  const kernel = options.kernel,
    management = options.management,
    store = options.store,
    bearers = options.bearers;
  const ingressBytes = options.ingressBytes ?? 1_048_576,
    timeoutMs = options.timeoutMs ?? 30_000,
    bufferBytes = options.bufferBytes ?? 65_536;
  if (
    !Number.isSafeInteger(ingressBytes) ||
    ingressBytes < 1024 ||
    ingressBytes > 16_777_216 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000 ||
    !Number.isSafeInteger(bufferBytes) ||
    bufferBytes < 1024 ||
    bufferBytes > 1_048_576 ||
    options.intentHmacKey.byteLength !== 32
  ) {
    throw new KernelError("invalid");
  }
  if (
    options.lifecycle !== undefined &&
    (!Object.is(options.lifecycle.contract, c.LIFECYCLE_CAPABILITY_CONTRACT) ||
      !["enabled", "disabled"].includes(options.lifecycle.writeGate) ||
      Object.keys(options.lifecycle).toSorted().join(",") !== "contract,writeGate")
  ) {
    throw new KernelError("invalid");
  }
  const lifecycleWriteGate = options.lifecycle?.writeGate ?? "disabled";
  const hmac = Buffer.from(options.intentHmacKey);
  bearers.configureExecutionKey(hmac);
  const profiles = new Map<
    string,
    {
      dto: c.Profile;
      maxOutputTokens: number;
      limits?: Readonly<ApprovedLimits>;
      nativeProfile?: NativeConnectionProfile;
    }
  >();
  for (const entry of options.profiles) {
    const nativeProfile = entry.nativeProfile;
    const capability = nativeProfile
      ? c.connectionProfileV3.parse(nativeProfile.capability)
      : undefined;
    const dto = capability
      ? {
          profileId: capability.profileId,
          protocol: capability.protocol,
          modelIds: [nativeProfile!.mount.model],
          authKinds: [
            ...new Set(
              nativeProfile!.legacyAliases
                .filter((alias) => compatibleLegacyConnection(nativeProfile!, alias.kind))
                .map((alias) =>
                  alias.kind === "api_key" ? ("api_key" as const) : ("oauth" as const),
                ),
            ),
          ],
        }
      : c.profile.parse(entry.dto);
    const oauth = dto.authKinds[0] === "oauth",
      definition = oauthProfileDefinition(dto.profileId);
    if (
      dto.protocol !== "openai-responses" ||
      dto.modelIds.length !== 1 ||
      (!nativeProfile &&
        (dto.authKinds.length !== 1 ||
          (oauth
            ? !management.supportsOAuthProfile(dto.profileId) ||
              !definition ||
              dto.modelIds[0] !== definition.model
            : dto.authKinds[0] !== "api_key" || !!definition))) ||
      (nativeProfile &&
        (!management.supportsConnectionProfile(dto.profileId) ||
          nativeProfile.mount.profile !== dto.profileId ||
          entry.dto.profileId !== dto.profileId)) ||
      profiles.has(dto.profileId) ||
      !Number.isSafeInteger(entry.maxOutputTokens) ||
      entry.maxOutputTokens < 1 ||
      entry.maxOutputTokens > 10_000_000
    ) {
      throw new KernelError("invalid");
    }
    profiles.set(dto.profileId, {
      dto: Object.freeze({
        ...dto,
        authKinds: Object.freeze([...dto.authKinds]) as unknown as c.Profile["authKinds"],
        modelIds: Object.freeze([...dto.modelIds]) as unknown as string[],
      }),
      maxOutputTokens: entry.maxOutputTokens,
      ...(entry.limits === undefined
        ? {}
        : { limits: Object.freeze(parse(c.limits, entry.limits)) }),
      ...(nativeProfile === undefined
        ? {}
        : { nativeProfile: Object.freeze({ ...nativeProfile, capability: capability! }) }),
    });
  }
  if ((!profiles.size && !management.supportsConnectionRecovery()) || profiles.size > 128) {
    throw new KernelError("invalid");
  }
  const withinProfile = (id: string, limits: ApprovedLimits): boolean => {
    const p = profiles.get(id);
    return (
      !!p &&
      limits.tokens <= p.maxOutputTokens &&
      (!p.limits ||
        (Object.keys(p.limits) as (keyof ApprovedLimits)[]).every((k) => limits[k] <= p.limits![k]))
    );
  };
  const enrollment =
    options.enrollment &&
    Object.freeze({
      originRef: options.enrollment.originRef,
      engineIncarnation: options.enrollment.engineIncarnation,
      worker: options.enrollment.worker,
    });
  if (enrollment) {
    identifier(enrollment.originRef);
    uuid(enrollment.engineIncarnation);
    uuid(enrollment.worker);
  }
  const transport = options.transport;
  const requireCurrent = (grant: Grant): void => {
    if (
      !bearers.current(grant) ||
      (grant.role === "execution" && Date.parse(grant.saved.admission.expiresAt) <= Date.now())
    ) {
      throw new KernelError("denied");
    }
  };
  async function operationDTO(context: TrustedContext, op: OperationStatus): Promise<c.Operation> {
    const oauthMethod =
      op.oauthMethod ?? (op.legacyConnectionKind === "device_code" ? "device_code" : undefined);
    if (op.state !== "applied") {
      return c.operation.parse({
        operationRef: op.operationRef,
        state: op.state,
        ...(oauthMethod === undefined ? {} : { oauthMethod }),
        ...(op.state === "unknown" || op.state === "rejected"
          ? {
              error: safe(
                "upstream_failure",
                op.state === "unknown" ? "effect_unknown" : "not_dispatched",
                { operationRef: op.operationRef },
              ),
            }
          : {}),
      });
    }
    // Persisted deadline marks preparation; close/fence acknowledgements have no
    // result variant. Readbacks use the original persisted account/epoch tuple.
    if (nonempty(op.executionRef) && nonempty(op.deadline)) {
      const saved = await kernel.savedExecution(context, op.executionRef);
      return c.preparationOperation.parse({
        operationRef: op.operationRef,
        state: "applied",
        result: {
          kind: "execution",
          executionRef: op.executionRef,
          accountRef: saved.admission.accountRef,
          authorizationEpoch: saved.admission.authorizationEpoch,
          deadline: saved.admission.expiresAt,
          state: executionState(saved.state),
        },
      });
    }
    if (nonempty(op.accountRef) && !nonempty(op.executionRef)) {
      const a = await management.account(context, op.accountRef);
      return c.accountOperation.parse({
        operationRef: op.operationRef,
        state: "applied",
        ...(oauthMethod === undefined ? {} : { oauthMethod }),
        result: {
          kind: "account",
          accountRef: op.accountRef,
          metadataRevision: op.revision ?? a.revision,
          authorizationEpoch: op.epoch ?? a.epoch,
        },
      });
    }
    return c.acknowledgementOperation.parse({ operationRef: op.operationRef, state: "applied" });
  }
  function callback(
    context: TrustedContext,
    grant: Grant,
    saved: SavedExecution,
    requestId: string,
    signal: AbortSignal,
    recordClaim?: (status: RequestStatus) => Promise<void>,
    recordNative?: (usage: NativeUsage) => Promise<void>,
  ): NativeCallback {
    if (!enrollment) {
      throw new KernelError("unavailable");
    }
    const peer = enrollment;
    const validProof = (input: NativeDispatchProof): NativeDispatchProof => {
      const proof = {
        executionRef: input.executionRef,
        requestRef: input.requestRef,
        worker: input.worker,
        token: input.token,
        native: {
          originRef: input.native.originRef,
          engineIncarnation: input.native.engineIncarnation,
          requestNonce: input.native.requestNonce,
          generation: input.native.generation,
        },
      };
      if (
        proof.executionRef !== saved.admission.executionRef ||
        proof.requestRef !== requestId ||
        proof.worker !== peer.worker ||
        proof.native.originRef !== peer.originRef ||
        proof.native.engineIncarnation !== peer.engineIncarnation ||
        proof.native.generation !== saved.generation
      ) {
        throw new KernelError("denied");
      }
      return proof;
    };
    const callbacks: NativeCallback = Object.freeze({
      async admit(requestNonce: string): Promise<NativePermit> {
        uuid(requestNonce);
        requireCurrent(grant);
        if (signal.aborted) {
          throw new KernelError("denied");
        }
        const fresh = savedCopy(await kernel.savedExecution(context, saved.admission.executionRef));
        if (!sameSaved(saved, fresh)) {
          throw new KernelError("denied");
        }
        try {
          const previous = await kernel.request(context, fresh.admission.executionRef, requestId);
          return { claim: { status: previous } };
        } catch (error) {
          // Absence is only permission to continue to atomic claim, never a
          // non-entry receipt or permission to replay an earlier transport.
          if (!(error instanceof KernelError) || error.code !== "unknown") {
            throw error;
          }
        }
        const mapping = await store.mapping(context, fresh.generation);
        if (
          !mapping ||
          mapping.consumerId !== context.consumerId ||
          mapping.accountRef !== fresh.admission.accountRef ||
          mapping.descriptor.profile !== fresh.admission.profileId ||
          mapping.descriptor.generation !== fresh.generation ||
          mapping.descriptor.nativePhysicalIdentity !== fresh.generation
        ) {
          throw new KernelError("denied");
        }
        const physical = physicalCandidate(mapping.descriptor);
        if (physical.model !== profiles.get(fresh.admission.profileId)?.dto.modelIds[0]) {
          throw new KernelError("denied");
        }
        await kernel.currentWorkerLease(context, peer.worker);
        requireCurrent(grant);
        if (signalAborted(signal)) {
          throw new KernelError("denied");
        }
        const claim = await kernel.claim(
          context,
          fresh.admission.executionRef,
          requestId,
          peer.worker,
          fresh.admission,
          { originRef: peer.originRef, engineIncarnation: peer.engineIncarnation, requestNonce },
        );
        if (recordClaim) {
          await recordClaim(claim.status);
        }
        if (!claim.dispatch) {
          return { claim };
        }
        try {
          const lease = await kernel.currentWorkerLease(context, peer.worker);
          requireCurrent(grant);
          if (signalAborted(signal)) {
            throw new KernelError("denied");
          }
          if (
            claim.dispatch.descriptor.generation !== physical.generation ||
            claim.dispatch.descriptor.nativePhysicalIdentity !== physical.nativePhysicalIdentity ||
            claim.dispatch.descriptor.profile !== physical.profile
          ) {
            throw new KernelError("denied");
          }
          const expiry = Math.min(Date.parse(lease), Date.parse(claim.dispatch.deadline));
          if (expiry <= Date.now()) {
            throw new KernelError("denied");
          }
          return { claim, physical, permitExpiresAt: new Date(expiry).toISOString() };
        } catch {
          await kernel.effect(
            context,
            fresh.admission.executionRef,
            requestId,
            peer.worker,
            "effect_unknown",
          );
          throw new KernelError("unknown");
        }
      },
      usage: async (proof: NativeDispatchProof, usage: NativeUsage) => {
        const p = validProof(proof),
          observed = nativeUsage(usage);
        const persisted = await kernel.requestProof(context, p.executionRef, p.requestRef);
        if (
          !persisted ||
          p.token !== persisted.token ||
          p.worker !== persisted.worker ||
          p.native.requestNonce !== persisted.native.requestNonce ||
          p.native.engineIncarnation !== persisted.native.engineIncarnation
        ) {
          throw new KernelError("denied");
        }
        if (observed.finalized && recordNative) {
          await recordNative(observed);
        }
      },
      effect: async (
        proof: NativeDispatchProof,
        next: "response_started" | "completed" | "effect_unknown",
      ) => {
        const p = validProof(proof);
        const persisted = await kernel.requestProof(context, p.executionRef, p.requestRef);
        if (
          !persisted ||
          p.token !== persisted.token ||
          p.worker !== persisted.worker ||
          p.native.requestNonce !== persisted.native.requestNonce ||
          p.native.originRef !== persisted.native.originRef ||
          p.native.engineIncarnation !== persisted.native.engineIncarnation ||
          p.native.generation !== persisted.native.generation
        ) {
          throw new KernelError("denied");
        }
        return kernel.effect(context, p.executionRef, p.requestRef, peer.worker, next);
      },
      rejectBeforeDispatch: (proof: NativeDispatchProof, entered: false) =>
        kernel.rejectBeforeDispatch(context, peer.worker, validProof(proof), entered),
      closed: (proof: NativeDispatchProof, cleanup?: CleanupAuthority) =>
        kernel.acknowledgeTransportClosed(context, peer.worker, validProof(proof), cleanup),
    });
    return Object.freeze({
      admit: (nonce: string) => inServiceLane("control", () => callbacks.admit(nonce)),
      usage: (proof: NativeDispatchProof, usage: NativeUsage) =>
        inServiceLane("control", () => callbacks.usage!(proof, usage)),
      effect: (
        proof: NativeDispatchProof,
        next: "response_started" | "completed" | "effect_unknown",
      ) => inServiceLane("control", () => callbacks.effect(proof, next)),
      rejectBeforeDispatch: (proof: NativeDispatchProof, entered: false) =>
        inServiceLane("control", () => callbacks.rejectBeforeDispatch(proof, entered)),
      closed: (proof: NativeDispatchProof, cleanup?: CleanupAuthority) =>
        inServiceLane("control", () => callbacks.closed(proof, cleanup)),
    });
  }
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      headersTimeout: Math.min(timeoutMs, 10_000),
      requestTimeout: timeoutMs,
      keepAliveTimeout: 1000,
      connectionsCheckingInterval: 1000,
    },
    (req, res) => {
      if (controlOnly && !facadeControlRoute(req.method, req.url)) {
        send(res, c.safeError, safe("invalid_request", "not_dispatched"), 400);
        return;
      }
      // Analytics reads may enter the protected origin, but do not consume the
      // admission or PostgreSQL slots reserved for proof/cleanup control work.
      const selectedLane =
        controlOnly && !facadeBoundedReadRoute(req.method, req.url) ? "control" : "data";
      const release = admission?.reserve(selectedLane);
      if (admission && !release) {
        res.shouldKeepAlive = false;
        let deniedIdentity: { requestRef?: string } = {};
        if (
          req.method === "POST" &&
          /^\/v1\/executions\/[A-Za-z0-9_-]+\/requests$/.test(req.url ?? "")
        ) {
          try {
            deniedIdentity = {
              requestRef: parse(c.reference, singleton(req, "x-gateway-request-id")),
            };
          } catch {
            /* no unvalidated identity */
          }
        }
        const refusal = safe("admission_limited", "not_dispatched", deniedIdentity);
        // The request has not entered the kernel, so its reference is reusable.
        send(
          res,
          c.safeError,
          deniedIdentity.requestRef !== undefined
            ? { ...refusal, retry: { kind: "after", milliseconds: 1000 } }
            : refusal,
          503,
        );
        return;
      }
      const retained = new Set<Promise<void>>();
      const retain = (work: Promise<void>) => {
        const settled = work.catch(() => {});
        retained.add(settled);
        void settled.then(() => retained.delete(settled));
        return settled;
      };
      const controller = new AbortController();
      const ingressTimer = setTimeout(() => {
        controller.abort();
        res.destroy();
      }, timeoutMs);
      const disconnected = () => {
        if (!res.writableFinished) {
          controller.abort();
        }
      };
      res.once("close", disconnected);
      res.once("finish", () => {
        clearTimeout(ingressTimer);
      });
      res.once("close", () => {
        clearTimeout(ingressTimer);
      });
      req.setTimeout(timeoutMs, () => {
        controller.abort();
        req.destroy();
      });
      res.setTimeout(timeoutMs, () => {
        controller.abort();
        res.destroy();
      });
      let enteredTransport = false,
        uncertain = false;
      let relayPhase: StreamRelayPhase | undefined;
      let transportScope: { context: TrustedContext; ref: string; id: string } | undefined;
      const markUnknown = async (): Promise<void> => {
        if (transportScope && enrollment && enteredTransport) {
          await inServiceLane("control", () =>
            kernel.effect(
              transportScope!.context,
              transportScope!.ref,
              transportScope!.id,
              enrollment.worker,
              "effect_unknown",
            ),
          ).catch(() => {});
        }
      };
      const onAbort = () => {
        void retain(markUnknown());
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      let identity: { operationRef?: string; requestRef?: string } = {};
      let limited: AdmissionLimitsScreen | undefined;
      const finishRequest = async (): Promise<void> => {
        clearTimeout(ingressTimer);
        res.removeListener("close", disconnected);
        controller.signal.removeEventListener("abort", onAbort);
        while (retained.size > 0) {
          const batch = Array.from(retained);
          await Promise.all(batch);
        }
      };
      void inServiceLane(selectedLane, () =>
        (async () => {
          if (req.rawHeaders.length > 64) {
            res.shouldKeepAlive = false;
            send(res, c.safeError, safe("invalid_request", "not_dispatched"), 400);
            return;
          }
          let authorization: string | undefined;
          try {
            authorization = singleton(req, "authorization");
          } catch {
            send(res, c.safeError, safe("unauthenticated", "not_dispatched"), 401);
            return;
          }
          if (
            !nonempty(authorization) ||
            !/^Bearer [A-Za-z0-9._~-]{16,1024}$/.test(authorization)
          ) {
            send(res, c.safeError, safe("unauthenticated", "not_dispatched"), 401);
            return;
          }
          const grant = await bearers.resolveExecution(authorization.slice(7), kernel);
          if (!grant) {
            send(res, c.safeError, safe("unauthenticated", "not_dispatched"), 401);
            return;
          }
          requireCurrent(grant);
          const context = captureContext(grant);
          if (
            !nonempty(req.url) ||
            req.url.length > 2048 ||
            !/^\/(?:v1|v2|v3|internal\/v1)\//.test(req.url) ||
            req.url.includes("#")
          ) {
            throw new KernelError("invalid");
          }
          const url = new URL(req.url, "http://facade.invalid");
          if (url.origin !== "http://facade.invalid") {
            throw new KernelError("invalid");
          }
          const path = url.pathname,
            method = req.method;
          const streamRoute =
            req.method === "POST" && /^\/v1\/executions\/[^/]+\/requests$/.test(path);
          if (
            singleton(req, "content-type") !== "application/json" ||
            singleton(req, "accept") !== (streamRoute ? "text/event-stream" : "application/json")
          ) {
            throw new KernelError("invalid");
          }
          const match =
            /^\/v1\/executions\/([A-Za-z0-9_-]+)(?:\/(requests)(?:\/([A-Za-z0-9_-]+))?|\/(close))?$/.exec(
              path,
            );
          const opMatch = /^\/v1\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
          if (
            url.search &&
            !(
              (path === "/v1/accounts" ||
                path === "/v2/accounts" ||
                path === "/v3/accounts" ||
                path === "/v1/usage" ||
                path === "/v2/usage") &&
              method === "GET"
            )
          ) {
            throw new KernelError("invalid");
          }
          if (
            (path === "/v1/account-info/read" || path === "/v2/account-info/read") &&
            method === "POST"
          ) {
            const input = parse(
              c.accountInfoReadRequest,
              strictJSON(
                await body(req, Math.min(ingressBytes, c.ACCOUNT_INFO_REQUEST_BYTES)),
                true,
              ),
            );
            if (
              (grant.role !== "consumer-control" && grant.role !== "management") ||
              !permitsOwner(grant, input.ownerRef)
            ) {
              throw new KernelError("denied");
            }
            const result = await accountInfo.readV2(
              {
                observe: async (selector) => {
                  requireCurrent(grant);
                  if (!kernel.accountInfoIdentities) {
                    throw new KernelError("unavailable");
                  }
                  const rows = await kernel.accountInfoIdentities(context, selector.accountRefs);
                  requireCurrent(grant);
                  if (
                    !permitsOwner(grant, selector.ownerRef) ||
                    rows.some(
                      (row) =>
                        row.ownerRef !== selector.ownerRef || !permitsProfile(grant, row.profile),
                    )
                  ) {
                    throw new KernelError("denied");
                  }
                  return rows;
                },
              },
              input,
              { consumerId: context.consumerId, signal: controller.signal },
            );
            requireCurrent(grant);
            if (path === "/v1/account-info/read") {
              send(
                res,
                c.accountInfoReadResponse,
                {
                  contract: c.ACCOUNT_INFO_CONTRACT,
                  accounts: result.accounts.map((row) => ({
                    ...row,
                    info: c.accountInfoToV1(row.info),
                  })),
                },
                200,
                true,
                c.ACCOUNT_INFO_RESPONSE_BYTES,
              );
            } else {
              send(
                res,
                c.accountInfoReadResponseV2,
                result,
                200,
                true,
                c.ACCOUNT_INFO_RESPONSE_BYTES,
              );
            }
            return;
          }
          if (path === "/v1/capabilities/account-limits-refresh" && method === "GET") {
            if (grant.role !== "consumer-control" && grant.role !== "management") {
              throw new KernelError("denied");
            }
            let capabilities: c.AccountLimitsRefreshCapabilities = {
              contract: c.ACCOUNT_LIMITS_REFRESH_CONTRACT,
              quotaOnlyRefresh: false,
              profileIds: [],
            };
            try {
              if (options.accountLimitsRefresh) {
                capabilities = parse(
                  c.accountLimitsRefreshCapabilities,
                  await options.accountLimitsRefresh.getAccountLimitsRefreshCapabilities(),
                );
              }
            } catch {
              /* Unsupported native versions never advertise refresh. */
            }
            requireCurrent(grant);
            send(res, c.accountLimitsRefreshCapabilities, capabilities, 200, true);
            return;
          }
          if (path === "/v1/capabilities/account-limits" && method === "GET") {
            if (grant.role !== "consumer-control" && grant.role !== "management") {
              throw new KernelError("denied");
            }
            let capabilities: c.AccountLimitsCapabilities = {
              contract: c.ACCOUNT_LIMITS_CONTRACT,
              cachedRead: false,
              quotaOnlyRefresh: false,
            };
            try {
              if (options.accountLimits) {
                capabilities = parse(
                  c.accountLimitsCapabilities,
                  await options.accountLimits.getAccountLimitsCapabilities(),
                );
              }
            } catch {
              /* Missing/incompatible source never advertises a read capability. */
            }
            requireCurrent(grant);
            send(
              res,
              c.accountLimitsCapabilities,
              { ...capabilities, quotaOnlyRefresh: false },
              200,
              true,
            );
            return;
          }
          if (
            (path === "/v2/capabilities/account-limits" ||
              path === "/v3/capabilities/account-limits") &&
            method === "GET"
          ) {
            if (grant.role !== "consumer-control" && grant.role !== "management") {
              throw new KernelError("denied");
            }
            const v3 = path.startsWith("/v3/");
            const schema = v3 ? c.accountLimitsV3Capabilities : c.accountLimitsV2Capabilities;
            let capabilities: c.AccountLimitsV2Capabilities | c.AccountLimitsV3Capabilities = {
              contract: v3 ? c.ACCOUNT_LIMITS_V3_CONTRACT : c.ACCOUNT_LIMITS_V2_CONTRACT,
              cachedRead: false,
              quotaOnlyRefresh: false,
            };
            try {
              const source = v3 ? options.accountLimitsV3 : options.accountLimitsV2;
              if (source) {
                capabilities = parse<c.AccountLimitsV2Capabilities | c.AccountLimitsV3Capabilities>(
                  schema,
                  await source.getAccountLimitsCapabilities(),
                );
              }
            } catch {
              /* Missing/incompatible source never advertises a read capability. */
            }
            requireCurrent(grant);
            send(res, schema, { ...capabilities, quotaOnlyRefresh: false }, 200, true);
            return;
          }
          if (
            (path === "/v1/account-models/read" || path === "/v2/account-models/read") &&
            method === "POST"
          ) {
            const input = parse(
              c.accountModelsRequest,
              strictJSON(await body(req, Math.min(ingressBytes, 1024)), true),
            );
            if (
              (grant.role !== "management" && grant.role !== "consumer-control") ||
              !permitsProfile(grant, input.profileId) ||
              !permitsOwner(grant, input.ownerRef)
            ) {
              throw new KernelError("denied");
            }
            const selected = await kernel.account(context, input.accountRef);
            if (
              selected.ownerRef !== input.ownerRef ||
              selected.profile !== input.profileId ||
              selected.epoch !== input.expectedAuthorizationEpoch ||
              !["active", "suspended"].includes(selected.state)
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            if (path === "/v2/account-models/read") {
              const native = profiles.get(input.profileId)?.nativeProfile;
              const result = native
                ? await readAccountModelsV2(
                    options.accountModelsV2,
                    input,
                    native.capability.modelPolicy,
                    () => accountLimitsTarget(kernel, store, context, input),
                  )
                : { status: "unsupported" as const };
              requireCurrent(grant);
              send(res, c.accountModelsV2, result, 200, true, 2 * 1024 * 1024);
              return;
            }
            const result = configuredAccountModelSource(input.profileId)
              ? await readAccountModels(options.accountModels, input, () =>
                  accountLimitsTarget(kernel, store, context, input),
                )
              : { status: "unsupported" as const };
            requireCurrent(grant);
            send(res, c.accountModels, result, 200, true, 2 * 1024 * 1024);
            return;
          }
          const limitsRead = async (
            contract: "account-limits/v1" | "account-limits/v2" | "account-limits/v3",
            refresh = false,
          ) => {
            const input = parse(
              c.accountLimitsRequest,
              strictJSON(await body(req, Math.min(ingressBytes, 1024)), true),
            );
            const definition = providerConnectionDefinition(input.profileId);
            const native = profiles.get(input.profileId)?.nativeProfile;
            if (grant.role !== "management" && grant.role !== "consumer-control") {
              throw new KernelError("denied");
            }
            if (!permitsProfile(grant, input.profileId) || !permitsOwner(grant, input.ownerRef)) {
              throw new KernelError("denied");
            }
            const selectedAccount = await kernel.account(context, input.accountRef);
            if (
              selectedAccount.ownerRef !== input.ownerRef ||
              selectedAccount.profile !== input.profileId ||
              selectedAccount.epoch !== input.expectedAuthorizationEpoch ||
              !["active", "suspended"].includes(selectedAccount.state)
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            const limitsProvider = c.providerIdentity.safeParse(definition?.provider.identity);
            if (
              (contract === "account-limits/v3"
                ? native?.capability.limitsContract !== contract
                : !definition ||
                  !limitsProvider.success ||
                  definition.limitsContract !== contract) ||
              (refresh && input.profileId !== "openai-codex-oauth-responses-v1")
            ) {
              return { input, result: { status: "unsupported" as const } };
            }
            const before: { value?: PhysicalCandidate } = {};
            const authority = {
              authorize: async (selector: c.AccountLimitsRequest) => {
                const a = await kernel.account(context, selector.accountRef);
                return (
                  a.ownerRef === selector.ownerRef &&
                  a.profile === selector.profileId &&
                  a.epoch === selector.expectedAuthorizationEpoch &&
                  ["active", "suspended"].includes(a.state)
                );
              },
              currentIdentity: async (selector: c.AccountLimitsRequest) => {
                const current = await accountLimitsTarget(kernel, store, context, selector);
                if (before.value && !sameCandidate(before.value, current)) {
                  throw new KernelError("denied");
                }
                before.value = current;
                return current;
              },
            };
            const source =
              contract === "account-limits/v3"
                ? {
                    contract: "account-limits/v3" as const,
                    read: async (selector: c.AccountLimitsRequest): Promise<c.AccountLimitsV3> => {
                      if (!options.accountLimitsV3) {
                        return { status: "unavailable" };
                      }
                      const caps = parse(
                        c.accountLimitsV3Capabilities,
                        await options.accountLimitsV3.getAccountLimitsCapabilities(),
                      );
                      return caps.cachedRead
                        ? options.accountLimitsV3.readAccountLimits(selector)
                        : { status: "unavailable" };
                    },
                  }
                : contract === "account-limits/v1"
                  ? {
                      contract: "account-limits/v1" as const,
                      read: async (selector: c.AccountLimitsRequest): Promise<c.AccountLimits> => {
                        if (refresh) {
                          if (!options.accountLimitsRefresh) {
                            return { status: "unsupported" };
                          }
                          try {
                            const caps = parse(
                              c.accountLimitsRefreshCapabilities,
                              await options.accountLimitsRefresh.getAccountLimitsRefreshCapabilities(),
                            );
                            if (
                              !caps.quotaOnlyRefresh ||
                              !caps.profileIds.includes("openai-codex-oauth-responses-v1")
                            ) {
                              return { status: "unsupported" };
                            }
                          } catch {
                            return { status: "unsupported" };
                          }
                          requireCurrent(grant);
                          return options.accountLimitsRefresh.refreshAccountLimits(selector);
                        }
                        if (!options.accountLimits) {
                          return { status: "unavailable" };
                        }
                        const capabilities = parse(
                          c.accountLimitsCapabilities,
                          await options.accountLimits.getAccountLimitsCapabilities(),
                        );
                        return capabilities.cachedRead
                          ? options.accountLimits.readAccountLimits(selector)
                          : { status: "unavailable" };
                      },
                    }
                  : {
                      contract: "account-limits/v2" as const,
                      read: async (
                        selector: c.AccountLimitsRequest,
                      ): Promise<c.AccountLimitsV2> => {
                        if (!options.accountLimitsV2) {
                          return { status: "unavailable" };
                        }
                        const capabilities = parse(
                          c.accountLimitsV2Capabilities,
                          await options.accountLimitsV2.getAccountLimitsCapabilities(),
                        );
                        return capabilities.cachedRead
                          ? options.accountLimitsV2.readAccountLimits(selector)
                          : { status: "unavailable" };
                      },
                    };
            const result = await readCachedAccountLimits(authority, source, input, {
              contract,
              provider:
                contract === "account-limits/v3"
                  ? native!.capability.provider.id
                  : limitsProvider.success
                    ? limitsProvider.data
                    : undefined,
            });
            requireCurrent(grant);
            if (
              result.wire.status === "snapshot" &&
              result.wire.physicalGeneration !== before.value?.generation
            ) {
              throw new KernelError("denied");
            }
            return { input, result: result.wire };
          };
          if (path === "/v1/account-limits/refresh" && method === "POST") {
            const { result } = await limitsRead("account-limits/v1", true);
            send(res, c.accountLimits, result as c.AccountLimits, 200, true);
            return;
          }
          if (path === "/v1/account-limits/read" && method === "POST") {
            if (grant.role !== "consumer-control" && grant.role !== "management") {
              throw new KernelError("denied");
            }
            const { result } = await limitsRead("account-limits/v1");
            send(res, c.accountLimits, result as c.AccountLimits, 200, true);
            return;
          }
          if (path === "/v2/account-limits/read" && method === "POST") {
            if (grant.role !== "consumer-control" && grant.role !== "management") {
              throw new KernelError("denied");
            }
            const { result } = await limitsRead("account-limits/v2");
            send(res, c.accountLimitsV2, result as c.AccountLimitsV2, 200, true);
            return;
          }
          if (path === "/v3/account-limits/read" && method === "POST") {
            const { result } = await limitsRead("account-limits/v3");
            send(res, c.accountLimitsV3, result as c.AccountLimitsV3, 200, true);
            return;
          }
          const usageMatch = /^\/v[12]\/usage\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
          if (usageMatch && method === "GET") {
            if (grant.role !== "consumer-control" || !options.usage) {
              throw new KernelError("denied");
            }
            const executionRef = parse(c.reference, usageMatch[1]),
              requestRef = parse(c.reference, usageMatch[2]);
            uuid(executionRef);
            const observation = await options.usage.observe(context, executionRef, requestRef);
            requireCurrent(grant);
            if (path.startsWith("/v2/")) {
              send(res, c.usageReadV2, {
                observation: observation === null ? null : c.projectUsageV2(observation),
              });
            } else {
              send(res, c.usageRead, {
                observation: observation === null ? null : c.projectUsageV1(observation),
              });
            }
            return;
          }
          if ((path === "/v1/usage" || path === "/v2/usage") && method === "GET") {
            if (grant.role !== "consumer-control" || !options.usage) {
              throw new KernelError("denied");
            }
            const values: Record<string, unknown> = {};
            for (const [key, value] of url.searchParams) {
              if (Object.hasOwn(values, key)) {
                throw new KernelError("invalid");
              }
              values[key] = key === "limit" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
            }
            const page = await options.usage.list(context, parse(c.usageQuery, values));
            requireCurrent(grant);
            if (path.startsWith("/v2/")) {
              send(res, c.usagePageV2, {
                ...page,
                observations: page.observations.map(c.projectUsageV2),
              });
            } else {
              send(res, c.usagePage, {
                ...page,
                observations: page.observations.map(c.projectUsageV1),
              });
            }
            return;
          }
          if (path === "/internal/v1/run-access") {
            if (grant.role !== "run-control" && grant.role !== "consumer-control") {
              throw new KernelError("denied");
            }
            if (method !== "POST" || req.url !== "/internal/v1/run-access") {
              throw new KernelError("invalid");
            }
            // Strict shared wire parsing captures independent immutable RR policy
            // before any authority/SQL await. No caller-supplied consumer or role.
            const parsed = parse(
              c.prepare,
              strictJSON(await body(req, Math.min(ingressBytes, 16_384)), true),
            );
            const input = Object.freeze({
              ...parsed,
              accountRefs: Object.freeze([...parsed.accountRefs]),
              limits: Object.freeze({ ...parsed.limits }),
            });
            identity = { operationRef: input.operationId };
            if (
              input.accountRefs.length > 16 ||
              new Set(input.accountRefs).size !== input.accountRefs.length
            ) {
              throw new KernelError("invalid");
            }
            input.accountRefs.forEach(uuid);
            identifier(input.profileId, 64);
            const profile = profiles.get(input.profileId);
            if (
              !grant.profileIds.includes(input.profileId) ||
              !profile ||
              !withinProfile(input.profileId, input.limits) ||
              input.limits.requestBytes > ingressBytes ||
              input.limits.concurrency > input.limits.requests ||
              (Object.keys(grant.limits) as (keyof ApprovedLimits)[]).some(
                (key) => input.limits[key] > grant.limits[key],
              )
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            let old: OperationStatus | undefined;
            try {
              old = await kernel.operation(context, input.operationId);
            } catch (error) {
              if (!(error instanceof KernelError) || error.code !== "unknown") {
                throw error;
              }
            }
            if (old && (!nonempty(old.executionRef) || !nonempty(old.deadline))) {
              throw new KernelError("conflict");
            }
            const original =
              old && savedCopy(await kernel.savedExecution(context, old.executionRef!));
            // Ownership only: never derive original admission/epoch from Account GET.
            const accounts: AccountStatus[] = [];
            for (const ref of input.accountRefs) {
              const account = await management.account(context, ref);
              if (
                (grant.role === "run-control" && !grant.ownerRefs.includes(account.ownerRef)) ||
                account.profile !== input.profileId
              ) {
                throw new KernelError("denied");
              }
              accounts.push(account);
            }
            if (
              (!original && Date.parse(input.deadline) <= Date.now()) ||
              Date.parse(input.deadline) - Date.now() > grant.maxRunMs
            ) {
              throw new KernelError("denied");
            }
            // A recorded operation replays as is; only a new selection is screened.
            limited = old ? undefined : await options.admissionLimits?.screen(context, accounts);
            const issuer = original?.admission.issuerEpoch ?? (await kernel.issuer(context));
            requireCurrent(grant);
            const tuple = [
              "account-gateway/facade-prepare/v1",
              context.consumerId,
              input.invocationRef,
              input.attemptRef,
              [...input.accountRefs],
              input.profileId,
              input.subjectRef,
              input.policyRevision,
              input.bindingRevision,
              issuer,
              input.deadline,
              input.limits.requests,
              input.limits.concurrency,
              input.limits.requestBytes,
              input.limits.outputBytes,
              input.limits.tokens,
            ];
            uncertain = true;
            const op = await kernel.prepare(context, {
              operationId: input.operationId,
              intentDigest: createHmac("sha256", hmac).update(JSON.stringify(tuple)).digest("hex"),
              invocationRef: input.invocationRef,
              attemptRef: input.attemptRef,
              permittedAccounts: input.accountRefs,
              profile: input.profileId,
              policySubject: input.subjectRef,
              policyRevision: input.policyRevision,
              bindingRevision: input.bindingRevision,
              issuerEpoch: issuer,
              deadline: new Date(input.deadline),
              limits: input.limits,
              limitedAccounts: limited?.limitedAccounts ?? [],
            });
            if (op.state !== "applied" || !nonempty(op.executionRef)) {
              throw new KernelError("unavailable");
            }
            const saved = savedCopy(await kernel.savedExecution(context, op.executionRef));
            // Exact original intent keeps its persisted issuer for HMAC/readback;
            // restore rotation must still deny the fenced issuance exception.
            if (
              saved.state === "fenced" &&
              (await kernel.issuer(context)) !== saved.admission.issuerEpoch
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            const bearer = bearers.upsertExecution(grant, saved, original);
            const {
              executionRef: _execution,
              issuerEpoch: _issuer,
              ...projection
            } = saved.admission;
            const result: RunAccess = {
              operation: c.preparationOperation.parse({
                operationRef: op.operationRef,
                state: "applied",
                result: {
                  kind: "execution",
                  executionRef: saved.admission.executionRef,
                  accountRef: saved.admission.accountRef,
                  authorizationEpoch: saved.admission.authorizationEpoch,
                  deadline: saved.admission.expiresAt,
                  state: executionState(saved.state),
                },
              }),
              bearer,
              admission: c.admission.parse(projection),
            };
            send(res, { parse: (value: RunAccess) => value }, result);
            return;
          }
          if (grant.role === "run-control") {
            throw new KernelError("denied");
          }
          if (grant.role === "execution") {
            if (!match && !(opMatch && method === "GET")) {
              throw new KernelError("denied");
            }
            if (match && match[1] !== grant.saved.admission.executionRef) {
              throw new KernelError("denied");
            }
          }
          if (opMatch && method === "GET") {
            identity = { operationRef: parse(c.reference, opMatch[1]) };
            uncertain = true;
            let op = await kernel.operation(context, identity.operationRef!);
            if (
              grant.role === "execution" &&
              op.executionRef !== grant.saved.admission.executionRef
            ) {
              throw new KernelError("denied");
            }
            if (grant.role === "management" && nonempty(op.accountRef)) {
              const account = await management.account(context, op.accountRef);
              if (
                !permitsOwner(grant, account.ownerRef) ||
                ((op.state === "pending" || op.state === "unknown") &&
                  !permitsProfile(grant, account.profile))
              ) {
                throw new KernelError("denied");
              }
            }
            if (grant.role === "consumer-control") {
              if (
                nonempty(op.accountRef) &&
                !grant.profileIds.includes(
                  (await management.account(context, op.accountRef)).profile,
                )
              ) {
                throw new KernelError("denied");
              }
              if (
                nonempty(op.executionRef) &&
                !grant.profileIds.includes(
                  (await kernel.savedExecution(context, op.executionRef)).admission.profileId,
                )
              ) {
                throw new KernelError("denied");
              }
            }
            // Check the owner BEFORE touching protected native readback. Reconcile
            // only the original journal; the ordinary response has no capability.
            requireCurrent(grant);
            if (
              (grant.role === "management" || grant.role === "consumer-control") &&
              (op.state === "pending" || op.state === "unknown")
            ) {
              op = await management.operation(context, identity.operationRef!);
            }
            const dto = await operationDTO(context, op);
            if (grant.role === "management" || grant.role === "consumer-control") {
              requireCurrent(grant);
            }
            send(res, c.operation, dto);
            return;
          }
          if (match) {
            const ref = parse(c.reference, match[1]);
            if (grant.role !== "execution") {
              throw new KernelError("denied");
            }
            if (method === "GET" && !match[2] && !match[4]) {
              const saved = await kernel.savedExecution(context, ref);
              send(
                res,
                c.execution,
                c.execution.parse({
                  executionRef: ref,
                  accountRef: saved.admission.accountRef,
                  authorizationEpoch: saved.admission.authorizationEpoch,
                  profileId: saved.admission.profileId,
                  deadline: saved.admission.expiresAt,
                  state: executionState(saved.state),
                }),
              );
              return;
            }
            if (method === "GET" && match[3]) {
              identity = { requestRef: parse(c.reference, match[3]) };
              uncertain = true;
              send(
                res,
                c.requestStatus,
                requestDTO(await kernel.request(context, ref, identity.requestRef!)),
              );
              return;
            }
            if (method === "POST" && match[4]) {
              const input = parse(c.close, strictJSON(await body(req, ingressBytes), true));
              identity = { operationRef: input.operationId };
              requireCurrent(grant);
              uncertain = true;
              send(
                res,
                c.acknowledgementOperation,
                await operationDTO(context, await kernel.close(context, input.operationId, ref)),
              );
              return;
            }
            if (method !== "POST" || !match[2] || match[3]) {
              throw new KernelError("invalid");
            }
            identity = { requestRef: parse(c.reference, singleton(req, "x-gateway-request-id")) };
            const header = singleton(req, "x-gateway-admission")!;
            if (Buffer.byteLength(header) > 4096) {
              throw new KernelError("invalid");
            }
            const wireAdmission = parse(c.admission, strictJSON(Buffer.from(header), true));
            const saved = savedCopy(await kernel.savedExecution(context, ref));
            const supplied = savedCopy({
              ...saved,
              admission: {
                ...wireAdmission,
                executionRef: ref,
                issuerEpoch: grant.saved.admission.issuerEpoch,
              },
            });
            if (
              !sameSaved(saved, grant.saved) ||
              !sameSaved(saved, supplied) ||
              !saved.dispatchAllowed
            ) {
              throw new KernelError("denied");
            }
            const profile = profiles.get(saved.admission.profileId);
            if (
              !profile ||
              !withinProfile(saved.admission.profileId, saved.admission.limits) ||
              saved.admission.limits.requestBytes > ingressBytes
            ) {
              throw new KernelError("denied");
            }
            const raw = await body(
              req,
              Math.min(ingressBytes, saved.admission.limits.requestBytes),
            );
            parse(secretSubmission.nativeRequest, {
              requestId: identity.requestRef,
              admission: wireAdmission,
              body: raw,
            });
            let admittedModels: {
              modelIds: readonly string[];
              models?: Parameters<typeof validateResponses>[3];
              enforceCapabilities: boolean;
            } = {
              modelIds: profile.dto.modelIds,
              models: providerConnectionDefinition(saved.admission.profileId)?.models,
              enforceCapabilities: false,
            };
            if (profile.nativeProfile || configuredAccountModelSource(saved.admission.profileId)) {
              requireCurrent(grant);
              const selected = await kernel.account(context, saved.admission.accountRef);
              const selector: c.AccountModelsRequest = {
                ownerRef: selected.ownerRef,
                accountRef: saved.admission.accountRef,
                profileId: saved.admission.profileId,
                expectedAuthorizationEpoch: saved.admission.authorizationEpoch,
              };
              const currentIdentity = async () => {
                const current = await accountLimitsTarget(kernel, store, context, selector);
                if (current.nativePhysicalIdentity !== saved.generation) {
                  throw new KernelError("denied");
                }
                return current;
              };
              admittedModels = profile.nativeProfile
                ? accountModelAdmissionV2(
                    await readAccountModelsV2(
                      options.accountModelsV2,
                      selector,
                      profile.nativeProfile.capability.modelPolicy,
                      currentIdentity,
                    ),
                    profile.dto.modelIds[0],
                    profile.nativeProfile.capability.modelPolicy,
                  )
                : accountModelAdmission(
                    await readAccountModels(options.accountModels, selector, currentIdentity),
                    profile.dto.modelIds[0],
                    configuredAccountModelSource(saved.admission.profileId),
                  );
              requireCurrent(grant);
            }
            const requestedModel = validateResponses(
              raw,
              admittedModels.modelIds,
              profile.maxOutputTokens,
              admittedModels.models,
              admittedModels.enforceCapabilities,
              configuredAccountModelSource(saved.admission.profileId),
            );
            requireCurrent(grant);
            if (!transport || !enrollment) {
              throw new KernelError("unavailable");
            }
            const remainingMs = Date.parse(saved.admission.expiresAt) - Date.now();
            if (controller.signal.aborted || remainingMs <= 0) {
              throw new KernelError("denied");
            }
            const abortAt = setTimeout(() => {
              controller.abort();
            }, remainingMs);
            // The authorized body is complete. Quiet inference is bounded by the
            // saved absolute deadline and peer cancellation, not ingress idle.
            clearTimeout(ingressTimer);
            req.setTimeout(0);
            res.setTimeout(0);
            const capture = new ResponsesUsageCapture(),
              occurredAt = new Date().toISOString();
            const factBase = executionUsageBase(
              saved.admission,
              identity.requestRef!,
              requestedModel,
              occurredAt,
            );
            let recordedClaim = false,
              nativeObserved = false;
            const claimRecorded = (): boolean => recordedClaim;
            const nativeUsageObserved = (): boolean => nativeObserved;
            const nativeCallback = callback(
              context,
              grant,
              saved,
              identity.requestRef!,
              controller.signal,
              async (status) => {
                if (options.usage) {
                  await options.usage.append(context, {
                    ...factBase,
                    revision: 0,
                    effect: status.effect,
                    ...capture.snapshot(),
                  });
                  recordedClaim = true;
                }
              },
              async (observed) => {
                if (options.usage && recordedClaim) {
                  const status = await kernel.request(context, ref, identity.requestRef!);
                  await options.usage.append(
                    context,
                    nativeUsageObservation(
                      {
                        ...factBase,
                        revision: 2,
                        effect: status.effect,
                      },
                      observed,
                    ),
                  );
                  nativeObserved = true;
                }
              },
            );
            transportScope = { context, ref, id: identity.requestRef! };
            enteredTransport = true;
            uncertain = true;
            try {
              const result = await transport.request({
                context,
                saved,
                requestId: identity.requestRef!,
                body: raw,
                signal: controller.signal,
                callback: nativeCallback,
              });
              if (result.kind === "status") {
                send(
                  res,
                  c.requestStatus,
                  requestDTO(
                    await inServiceLane("control", () =>
                      kernel.request(context, ref, identity.requestRef!),
                    ),
                  ),
                  202,
                );
                return;
              }
              let finished = false;
              let cancellation: Promise<void> | undefined;
              const cancel = () =>
                (cancellation ??= retain(inServiceLane("control", () => result.cancel())));
              const onStreamAbort = (): void => {
                void cancel();
              };
              controller.signal.addEventListener("abort", onStreamAbort, { once: true });
              try {
                // Streaming data requires actual persisted callback claim, never an
                // injected response substituting for the kernel's authority.
                const status = await inServiceLane("control", () =>
                  kernel.request(context, ref, identity.requestRef!),
                );
                if (
                  !["dispatch_started", "response_started", "completed"].includes(status.effect) ||
                  signalAborted(controller.signal)
                ) {
                  throw new KernelError("unknown");
                }
                res.writeHead(200, {
                  "content-type": "text/event-stream",
                  "x-gateway-request-ref": identity.requestRef!,
                  "cache-control": "no-store",
                });
                res.flushHeaders();
                let output = 0;
                for await (const chunk of result.body) {
                  relayPhase = "relay_chunk";
                  capture.push(chunk);
                  output += chunk.byteLength;
                  if (
                    !(chunk instanceof Uint8Array) ||
                    chunk.byteLength > bufferBytes ||
                    output > saved.admission.limits.outputBytes ||
                    signalAborted(controller.signal)
                  ) {
                    throw new KernelError("unknown");
                  }
                  relayPhase = "relay_write";
                  if (!res.write(chunk)) {
                    await once(res, "drain", { signal: controller.signal });
                  }
                  relayPhase = undefined;
                }
                // New data admission cannot take EOF away from an accepted effect.
                relayPhase = "relay_terminal";
                const terminal = await inServiceLane("control", () =>
                  kernel.request(context, ref, identity.requestRef!),
                );
                if (terminal.effect !== "completed" || signalAborted(controller.signal)) {
                  if (terminal.effect !== "completed") {
                    relayPhase = undefined;
                  }
                  throw new KernelError("unknown");
                }
                finished = true;
                res.end();
              } finally {
                controller.signal.removeEventListener("abort", onStreamAbort);
                if (!finished) {
                  controller.abort();
                  await cancel();
                }
              }
            } finally {
              clearTimeout(abortAt);
              if (options.usage && !claimRecorded()) {
                reportUsageObservationFailure("claim_observation_unconfirmed");
              }
              if (claimRecorded() && !nativeUsageObserved() && options.usage) {
                // Initial durable partial fact survives producer/network loss. A final
                // observation failure never repeats inference or loses that fact.
                try {
                  const status = await kernel.request(context, ref, identity.requestRef!);
                  await options.usage.append(context, {
                    ...factBase,
                    revision: 1,
                    effect: status.effect,
                    ...capture.snapshot(),
                  });
                } catch (error) {
                  // Keep the initial partial observation, never fabricate usage.
                  reportUsageObservationFailure("fallback_settlement", error);
                }
              }
            }
            return;
          }
          if (grant.role !== "management" && grant.role !== "consumer-control") {
            throw new KernelError("denied");
          }
          const reply = <T>(
            schema: Pick<Schema<T>, "parse">,
            value: T,
            status = 200,
            _privateCache = false,
          ): void => {
            requireCurrent(grant);
            send(res, schema, value, status);
          };
          if (path === "/v1/profiles" && method === "GET") {
            reply(c.profiles, {
              profiles: [...profiles.values()]
                .filter((p) => permitsProfile(grant, p.dto.profileId) && p.dto.authKinds.length > 0)
                .map((p) => p.dto),
            });
            return;
          }
          const connectionSnapshot = (
            selection: c.ConnectionBinding,
            action: "create" | "reconnect",
          ) => {
            const native = profiles.get(selection.profileId)?.nativeProfile;
            const selected = native?.capability.methods.find(
              (entry) =>
                entry.methodId === selection.methodId &&
                entry.revision === selection.methodRevision &&
                entry.configurationGeneration === selection.configurationGeneration,
            );
            if (
              !native ||
              native.capability.availability !== "enabled" ||
              !selected ||
              !c.supportsConnectionMethod(selected) ||
              selected.availability !== "enabled" ||
              !selected[action] ||
              !permitsProfile(grant, selection.profileId)
            ) {
              throw new KernelError("denied");
            }
            if (
              selected.allowedCredentialPolicies.some((policy) => policy !== "provider_key") &&
              !permitsOAuthProfile(grant, selection.profileId)
            ) {
              throw new KernelError("denied");
            }
            return c.connectionSnapshot.parse({ connection: selection, method: selected });
          };
          const connectionResult = async (op: OperationStatus) =>
            c.connectionOperation.parse({
              operation: await operationDTO(context, op),
              connection: (await management.connectionSnapshot(context, op)) ?? null,
            });
          const legacySelection = (
            profileId: string,
            kind: LegacyConnectionKind,
            action: "create" | "reconnect",
          ) => {
            const native = profiles.get(profileId)?.nativeProfile;
            const alias = native && compatibleLegacyConnection(native, kind);
            if (!alias) {
              throw new KernelError("denied");
            }
            return {
              snapshot: connectionSnapshot(alias.connection, action),
              legacyConnectionKind: alias.kind,
              inputFieldId: alias.inputFieldId,
            };
          };
          const replyOAuthBegin = async (
            result: Awaited<ReturnType<AccountManagement["beginOAuth"]>>,
          ) => {
            reply(
              c.oauthBeginResponse,
              {
                operation: await operationDTO(context, result.operation),
                ...(result.authorizationURL === undefined
                  ? {}
                  : { authorizationURL: result.authorizationURL }),
                ...(result.deviceAuthorization === undefined
                  ? {}
                  : { deviceAuthorization: result.deviceAuthorization }),
              },
              result.operation.state === "pending" ? 202 : 200,
            );
          };
          if (path === "/v3/provider-connection-capabilities" && method === "GET") {
            reply(c.providerConnectionCapabilitiesV3, {
              contract: c.PROVIDER_CONNECTIONS_V3_CONTRACT,
              capabilities: [...profiles.values()]
                .filter(
                  (p) => p.nativeProfile !== undefined && permitsProfile(grant, p.dto.profileId),
                )
                .map((p) => p.nativeProfile!.capability),
            });
            return;
          }
          const connectionReconnectMatch =
            /^\/v3\/accounts\/([A-Za-z0-9_-]+)\/connections\/reconnect$/.exec(path);
          if (
            method === "POST" &&
            (path === "/v3/accounts/connections/begin" || connectionReconnectMatch)
          ) {
            const raw = strictJSON(await body(req, Math.min(ingressBytes, 80 * 1024)), true);
            let result: Awaited<ReturnType<AccountManagement["beginConnection"]>>;
            if (connectionReconnectMatch) {
              const input = parse(secretSubmission.connectionReconnect, raw);
              const accountRef = parse(c.reference, connectionReconnectMatch[1]);
              const account = await management.account(context, accountRef);
              if (
                !permitsOwner(grant, account.ownerRef) ||
                account.profile !== input.connection.profileId
              ) {
                throw new KernelError("denied");
              }
              const snapshot = connectionSnapshot(input.connection, "reconnect");
              identity = { operationRef: input.operationId };
              requireCurrent(grant);
              uncertain = true;
              result = await management.reconnectConnection(context, {
                operationId: input.operationId,
                accountRef,
                expectedRevision: input.expectedMetadataRevision,
                snapshot,
                inputFields: input.inputFields,
              });
            } else {
              const input = parse(secretSubmission.connectionBegin, raw);
              if (!permitsOwner(grant, input.ownerRef)) {
                throw new KernelError("denied");
              }
              const snapshot = connectionSnapshot(input.connection, "create");
              identity = { operationRef: input.operationId };
              requireCurrent(grant);
              uncertain = true;
              result = await management.beginConnection(context, {
                operationId: input.operationId,
                ownerRef: input.ownerRef,
                displayName: input.displayName,
                snapshot,
                inputFields: input.inputFields,
              });
            }
            const connectionReply = await connectionResult(result.operation);
            reply(
              c.connectionBeginResponse,
              c.connectionBeginResponse.parse({
                ...connectionReply,
                ...(result.authorizationURL === undefined
                  ? {}
                  : { challenge: { kind: "browser", authorizationURL: result.authorizationURL } }),
                ...(result.deviceAuthorization === undefined
                  ? {}
                  : { challenge: { kind: "device", ...result.deviceAuthorization } }),
              }),
              result.operation.state === "pending" ? 202 : 200,
            );
            return;
          }
          if (
            method === "POST" &&
            (path === "/v3/accounts/connections/submit" || path === "/v3/accounts/connections/poll")
          ) {
            const raw = strictJSON(await body(req, Math.min(ingressBytes, 80 * 1024)), true);
            const input = path.endsWith("/submit")
              ? parse(secretSubmission.connectionSubmit, raw)
              : parse(c.connectionOperationRequest, raw);
            const original = await kernel.operation(context, input.operationId);
            if (!original.connection || !nonempty(original.accountRef)) {
              throw new KernelError("denied");
            }
            const account = await management.account(context, original.accountRef);
            if (
              account.ownerRef !== input.ownerRef ||
              !permitsOwner(grant, account.ownerRef) ||
              !permitsProfile(grant, account.profile)
            ) {
              throw new KernelError("denied");
            }
            identity = { operationRef: input.operationId };
            requireCurrent(grant);
            uncertain = true;
            let operation: OperationStatus;
            if ("inputFields" in input) {
              const fields = parse(secretSubmission.connectionSubmit, raw).inputFields;
              if (
                original.connection.method.interaction.kind !== "browser" ||
                Object.keys(fields).length !== 1 ||
                typeof fields.completion !== "string" ||
                !fields.completion.length
              ) {
                throw new KernelError("invalid");
              }
              operation = await management.completeOAuth(context, {
                operationId: input.operationId,
                ownerRef: input.ownerRef,
                authorizationCode: fields.completion,
              });
            } else {
              if (original.connection.method.interaction.kind !== "device") {
                throw new KernelError("denied");
              }
              operation = await management.pollDeviceOAuth(context, input);
            }
            reply(
              c.connectionOperation,
              await connectionResult(operation),
              operation.state === "pending" ? 202 : 200,
            );
            return;
          }
          const connectionOperationMatch = /^\/v3\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
          if (connectionOperationMatch && method === "GET") {
            const operationId = parse(c.reference, connectionOperationMatch[1]);
            const original = await kernel.operation(context, operationId);
            if (!nonempty(original.accountRef) || nonempty(original.executionRef)) {
              throw new KernelError("denied");
            }
            const account = await management.account(context, original.accountRef);
            if (!permitsOwner(grant, account.ownerRef) || !permitsProfile(grant, account.profile)) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            reply(
              c.connectionOperation,
              await connectionResult(await management.operation(context, operationId)),
            );
            return;
          }
          if (
            (path === "/v1/provider-connection-capabilities" ||
              path === "/v2/provider-connection-capabilities") &&
            method === "GET"
          ) {
            const visible = [...profiles.values()]
              .filter((p) => permitsProfile(grant, p.dto.profileId))
              .map((p) => p.dto);
            if (
              !options.providerConnections &&
              ![...profiles.values()].some((p) => p.nativeProfile)
            ) {
              throw new KernelError("unavailable");
            }
            const snapshot = projectProviderConnections(
              [...profiles.values()].some((p) => p.nativeProfile)
                ? projectNativeConnectionsV2(
                    [...profiles.values()].flatMap((p) =>
                      p.nativeProfile ? [p.nativeProfile] : [],
                    ),
                  )
                : await options.providerConnections!.getProviderConnectionCapabilities(),
              visible,
            );
            if (path.startsWith("/v2/")) {
              reply(c.providerConnectionCapabilitiesV2, snapshot);
            } else {
              reply(c.providerConnectionCapabilities, projectProviderConnectionsV1(snapshot));
            }
            return;
          }
          const lifecycleVersion = path.startsWith("/v3/") ? 3 : 2;
          const lifecycleGate =
            singleton(req, c.LIFECYCLE_CAPABILITY_HEADER, false) ===
              (lifecycleVersion === 3
                ? c.LIFECYCLE_V3_CAPABILITY_CONTRACT
                : c.LIFECYCLE_CAPABILITY_CONTRACT) &&
            singleton(req, c.LIFECYCLE_CLIENT_HEADER, false) ===
              (lifecycleVersion === 3
                ? c.LIFECYCLE_V3_CLIENT_CONTRACT
                : c.LIFECYCLE_CLIENT_CONTRACT);
          const lifecycleAccountProjection = (
            r: Parameters<typeof lifecycleAccountDTO>[0],
          ): c.LifecycleAccount | c.LifecycleAccountV3 =>
            lifecycleVersion === 3 ? lifecycleAccountV3DTO(r) : lifecycleAccountDTO(r);
          const lifecycleAccountSchema =
            lifecycleVersion === 3 ? c.lifecycleAccountV3 : c.lifecycleAccount;
          const lifecycleOperationSchema =
            lifecycleVersion === 3 ? c.lifecycleOperationV3 : c.lifecycleOperation;
          if (
            (path === "/v1/accounts" ||
              (lifecycleGate && (path === "/v2/accounts" || path === "/v3/accounts"))) &&
            method === "GET"
          ) {
            const query = new Map<string, unknown>();
            for (const [key, value] of url.searchParams) {
              if (query.has(key)) {
                throw new KernelError("invalid");
              }
              query.set(key, key === "limit" && /^[1-9]\d*$/.test(value) ? Number(value) : value);
            }
            // Own data properties preserve unknown names such as __proto__ for the
            // SDK strict schema; ordinary assignment could silently erase them.
            const input = parse(c.listQuery, Object.fromEntries(query));
            const consumerOwnerScope =
              grant.role === "management" && grant.ownerScope === "consumer";
            if (
              (grant.role === "consumer-control" || consumerOwnerScope) &&
              !nonempty(input.ownerRef)
            ) {
              throw new KernelError("denied");
            }
            if (nonempty(input.ownerRef) && !permitsOwner(grant, input.ownerRef)) {
              throw new KernelError("denied");
            }
            const page = await management.accounts(context, {
              ...input,
              allowedOwnerRefs:
                grant.role === "management" && !consumerOwnerScope
                  ? grant.ownerRefs
                  : [input.ownerRef!],
            });
            const visible = page.accounts.filter((a) => permitsProfile(grant, a.profile));
            if (path === "/v2/accounts" || path === "/v3/accounts") {
              const accounts = await Promise.all(
                visible.map((a) =>
                  management.lifecycle(context, a.accountRef).then(lifecycleAccountProjection),
                ),
              );
              reply(lifecycleVersion === 3 ? c.lifecycleAccountsV3 : c.lifecycleAccounts, {
                accounts,
                ...(nonempty(page.nextCursor) ? { nextCursor: page.nextCursor } : {}),
              });
              return;
            }
            if (visible.some((a) => a.state === "suspended")) {
              throw new KernelError("conflict");
            }
            reply(c.accounts, {
              accounts: visible.map(accountDTO),
              ...(nonempty(page.nextCursor) ? { nextCursor: page.nextCursor } : {}),
            });
            return;
          }
          if (lifecycleGate) {
            const lifecycleAccountDTOWithReadback = async (ref: string) =>
              lifecycleAccountProjection(await management.lifecycle(context, ref));
            const lifecycleOperationDTO = async (
              op: OperationStatus,
            ): Promise<c.LifecycleOperation | c.LifecycleOperationV3> => {
              if (
                !nonempty(op.accountRef) ||
                !op.lifecycle ||
                op.lifecycle.account.accountRef !== op.accountRef
              ) {
                throw new KernelError("conflict");
              }
              const original = op.lifecycle.account;
              const credential = op.lifecycle.publication?.credential;
              const legacy = profiles.get(original.profile);
              const account = lifecycleAccountProjection({
                account: original,
                authKind:
                  credential?.credentialKind ??
                  (legacy && !legacy.nativeProfile
                    ? oauthProfileDefinition(original.profile)
                      ? "oauth"
                      : "api_key"
                    : "unknown"),
                ...(credential === undefined ? {} : { credential }),
                resumeCustody:
                  original.state === "suspended" ? "attention_required" : "not_applicable",
              });
              const intent = {
                action: op.lifecycle.kind,
                accountRef: original.accountRef,
                profileId: original.profile,
                expectedMetadataRevision: op.lifecycle.expectedRevision,
              };
              if (op.state === "applied") {
                return lifecycleOperationSchema.parse({
                  operationRef: op.operationRef,
                  intent,
                  state: "applied",
                  result: { kind: "account_lifecycle", account },
                });
              }
              return lifecycleOperationSchema.parse({
                operationRef: op.operationRef,
                intent,
                state: op.state,
                account,
                ...(op.state === "pending"
                  ? {}
                  : {
                      error: safe(
                        "upstream_failure",
                        op.state === "unknown" ? "effect_unknown" : "not_dispatched",
                        { operationRef: op.operationRef },
                      ),
                    }),
              });
            };
            if (
              (path === "/v2/capabilities/account-lifecycle" ||
                path === "/v3/capabilities/account-lifecycle") &&
              method === "GET"
            ) {
              const schema =
                lifecycleVersion === 3 ? c.lifecycleCapabilityV3 : c.lifecycleCapability;
              reply<c.LifecycleCapability | c.LifecycleCapabilityV3>(
                schema,
                schema.parse({
                  contract:
                    lifecycleVersion === 3
                      ? c.LIFECYCLE_V3_CAPABILITY_CONTRACT
                      : c.LIFECYCLE_CAPABILITY_CONTRACT,
                  clientContract:
                    lifecycleVersion === 3
                      ? c.LIFECYCLE_V3_CLIENT_CONTRACT
                      : c.LIFECYCLE_CLIENT_CONTRACT,
                  writeGate: lifecycleWriteGate,
                  operations: ["suspend", "resume"],
                  custody: {
                    contract:
                      lifecycleVersion === 3
                        ? "native-retained-custody/v2"
                        : "native-retained-custody/v1",
                    api_key: "native-attestation-required",
                    oauth: "native-attestation-required",
                    ...(lifecycleVersion === 3 ? { native: "native-attestation-required" } : {}),
                  },
                }),
              );
              return;
            }
            const lifecycleAccountMatch =
              /^\/v[23]\/accounts\/([A-Za-z0-9_-]+)(?:\/(suspend|resume))?$/.exec(path);
            if (lifecycleAccountMatch) {
              const ref = parse(c.reference, lifecycleAccountMatch[1]);
              const account = await management.account(context, ref);
              if (
                !permitsOwner(grant, account.ownerRef) ||
                !permitsProfile(grant, account.profile)
              ) {
                throw new KernelError("denied");
              }
              if (method === "GET" && !lifecycleAccountMatch[2]) {
                reply(lifecycleAccountSchema, await lifecycleAccountDTOWithReadback(ref));
                return;
              }
              if (method === "POST" && lifecycleAccountMatch[2]) {
                if (lifecycleWriteGate !== "enabled") {
                  throw new KernelError("denied");
                }
                if (lifecycleVersion === 2) {
                  // A strict old client must never mutate an account whose result
                  // it cannot represent. Both versions enter the same kernel below.
                  await lifecycleAccountDTOWithReadback(ref);
                }
                const input = parse(
                  c.lifecycleTransition,
                  strictJSON(await body(req, Math.min(ingressBytes, 16_384)), true),
                );
                identity = { operationRef: input.operationId };
                requireCurrent(grant);
                uncertain = true;
                const op =
                  lifecycleAccountMatch[2] === "suspend"
                    ? await management.suspend(context, {
                        operationId: input.operationId,
                        accountRef: ref,
                        expectedRevision: input.expectedMetadataRevision,
                      })
                    : await management.resume(context, {
                        operationId: input.operationId,
                        accountRef: ref,
                        expectedRevision: input.expectedMetadataRevision,
                      });
                requireCurrent(grant);
                reply(
                  lifecycleOperationSchema,
                  await lifecycleOperationDTO(op),
                  op.state === "pending" ? 202 : 200,
                );
                return;
              }
            }
            const lifecycleOperationMatch = (
              lifecycleVersion === 3
                ? /^\/v3\/lifecycle\/operations\/([A-Za-z0-9_-]+)$/
                : /^\/v2\/operations\/([A-Za-z0-9_-]+)$/
            ).exec(path);
            if (lifecycleOperationMatch && method === "GET") {
              identity = { operationRef: parse(c.reference, lifecycleOperationMatch[1]) };
              requireCurrent(grant);
              const op = await kernel.operation(context, identity.operationRef!);
              if (!nonempty(op.accountRef) || !op.lifecycle) {
                throw new KernelError("denied");
              }
              const account = await management.account(context, op.accountRef);
              if (
                !permitsOwner(grant, account.ownerRef) ||
                !permitsProfile(grant, account.profile)
              ) {
                throw new KernelError("denied");
              }
              requireCurrent(grant);
              reply(lifecycleOperationSchema, await lifecycleOperationDTO(op));
              return;
            }
          }
          if (path === "/v1/accounts/oauth/begin" && method === "POST") {
            const parsed = parse(
              c.oauthBegin,
              strictJSON(await body(req, Math.min(ingressBytes, 16_384)), true),
            );
            const input = Object.freeze({ ...parsed });
            identity = { operationRef: input.operationId };
            const profile = profiles.get(input.profileId);
            if (profile?.nativeProfile) {
              if (!permitsOwner(grant, input.ownerRef)) {
                throw new KernelError("denied");
              }
              const selection = legacySelection(
                input.profileId,
                input.method === "device_code" ? "device_code" : "browser",
                "create",
              );
              requireCurrent(grant);
              uncertain = true;
              await replyOAuthBegin(
                await management.beginConnection(context, {
                  operationId: input.operationId,
                  ownerRef: input.ownerRef,
                  displayName: input.displayName,
                  snapshot: selection.snapshot,
                  legacyConnectionKind: selection.legacyConnectionKind,
                }),
              );
              return;
            }
            if (
              !permitsOwner(grant, input.ownerRef) ||
              !permitsProfile(grant, input.profileId) ||
              !permitsOAuthProfile(grant, input.profileId) ||
              !profile ||
              profile.dto.authKinds[0] !== "oauth" ||
              !management.supportsOAuthProfile(input.profileId)
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            uncertain = true;
            const result = await management.beginOAuth(context, {
              operationId: input.operationId,
              ownerRef: input.ownerRef,
              profile: input.profileId,
              displayName: input.displayName,
              method: input.method,
            });
            // A retired management grant never receives a newly returned owner URL.
            requireCurrent(grant);
            reply(
              c.oauthBeginResponse,
              {
                operation: await operationDTO(context, result.operation),
                ...(result.authorizationURL === undefined
                  ? {}
                  : { authorizationURL: result.authorizationURL }),
                ...(result.deviceAuthorization === undefined
                  ? {}
                  : {
                      deviceAuthorization: c.oauthDeviceAuthorization.parse(
                        result.deviceAuthorization,
                      ),
                    }),
              },
              result.operation.state === "pending" ? 202 : 200,
            );
            return;
          }
          if (path === "/v1/accounts/oauth/poll" && method === "POST") {
            const input = parse(
              c.oauthPoll,
              strictJSON(await body(req, Math.min(ingressBytes, 16_384)), true),
            );
            identity = { operationRef: input.operationId };
            const original = await kernel.operation(context, input.operationId);
            if (
              !nonempty(original.accountRef) ||
              nonempty(original.executionRef) ||
              (original.oauthMethod !== "device_code" &&
                original.legacyConnectionKind !== "device_code")
            ) {
              throw new KernelError("denied");
            }
            const account = await management.account(context, original.accountRef),
              profile = profiles.get(account.profile);
            if (
              account.ownerRef !== input.ownerRef ||
              !permitsOwner(grant, account.ownerRef) ||
              !permitsProfile(grant, account.profile) ||
              !permitsOAuthProfile(grant, account.profile) ||
              (original.connection
                ? original.legacyConnectionKind !== "device_code" ||
                  original.connection.method.interaction.kind !== "device"
                : !profile ||
                  profile.dto.authKinds[0] !== "oauth" ||
                  !management.supportsOAuthProfile(account.profile))
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            uncertain = true;
            const operation = await management.pollDeviceOAuth(context, input);
            const dto = await operationDTO(context, operation);
            requireCurrent(grant);
            reply(c.accountOperation, dto, operation.state === "pending" ? 202 : 200);
            return;
          }
          if (path === "/v1/accounts/oauth/complete" && method === "POST") {
            const input = parse(
              secretSubmission.oauthComplete,
              strictJSON(await body(req, 32_768), true),
            );
            identity = { operationRef: input.operationId };
            const original = await kernel.operation(context, input.operationId);
            if (!nonempty(original.accountRef) || nonempty(original.executionRef)) {
              throw new KernelError("denied");
            }
            const account = await management.account(context, original.accountRef),
              profile = profiles.get(account.profile);
            if (
              account.ownerRef !== input.ownerRef ||
              !permitsOwner(grant, account.ownerRef) ||
              !permitsProfile(grant, account.profile) ||
              !permitsOAuthProfile(grant, account.profile) ||
              (original.connection
                ? original.legacyConnectionKind !== "browser" ||
                  original.connection.method.interaction.kind !== "browser"
                : !profile ||
                  profile.dto.authKinds[0] !== "oauth" ||
                  !management.supportsOAuthProfile(account.profile))
            ) {
              throw new KernelError("denied");
            }
            const definition = oauthProfileDefinition(account.profile);
            const oauthCallback = original.connection
              ? {
                  authorizationCode:
                    "authorizationCode" in input ? input.authorizationCode : input.callbackURL,
                }
              : definition?.family === "claude"
                ? "authorizationCode" in input
                  ? secretSubmission.parseClaudeOAuthAuthorizationCode(input.authorizationCode)
                  : undefined
                : definition?.family === "grok"
                  ? "authorizationCode" in input
                    ? secretSubmission.grokOAuthAuthorizationCode.safeParse(input.authorizationCode)
                        .success
                      ? { authorizationCode: input.authorizationCode }
                      : undefined
                    : secretSubmission.parseGrokManualCallbackURL(input.callbackURL)
                  : definition?.family === "codex" && "callbackURL" in input
                    ? secretSubmission.parseOAuthCallbackURL(input.callbackURL)
                    : undefined;
            if (!oauthCallback) {
              throw new KernelError("invalid");
            }
            requireCurrent(grant);
            uncertain = true;
            const operation = await management.completeOAuth(context, {
              operationId: input.operationId,
              ownerRef: input.ownerRef,
              ...oauthCallback,
            });
            const dto = await operationDTO(context, operation);
            requireCurrent(grant);
            reply(c.accountOperation, dto, operation.state === "pending" ? 202 : 200);
            return;
          }
          if (path === "/v1/accounts" && method === "POST") {
            const bytes = await body(req, Math.max(ingressBytes, 400 * 1024));
            const input = parse(secretSubmission.connect, strictJSON(bytes, true));
            const importing = input.credential.kind === "credential_import";
            if (bytes.length > (importing ? 400 * 1024 : ingressBytes)) {
              throw new KernelError("invalid");
            }
            identity = { operationRef: input.operationId };
            if (!permitsOwner(grant, input.ownerRef) || !permitsProfile(grant, input.profileId)) {
              throw new KernelError("denied");
            }
            if (profiles.get(input.profileId)?.nativeProfile) {
              if (input.credential.kind === "oauth") {
                throw new KernelError("invalid");
              }
              const kind: LegacyConnectionKind =
                input.credential.kind === "api_key"
                  ? "api_key"
                  : `credential_import:${input.credential.method}`;
              const selection = legacySelection(input.profileId, kind, "create");
              if (!nonempty(selection.inputFieldId)) {
                throw new KernelError("denied");
              }
              requireCurrent(grant);
              uncertain = true;
              const result = await management.beginConnection(context, {
                operationId: input.operationId,
                ownerRef: input.ownerRef,
                displayName: input.displayName,
                snapshot: selection.snapshot,
                legacyConnectionKind: selection.legacyConnectionKind,
                inputFields: { [selection.inputFieldId]: input.credential.value },
              });
              reply(
                c.accountOperation,
                await operationDTO(context, result.operation),
                result.operation.state === "pending" ? 202 : 200,
              );
              return;
            }
            const auth = profiles.get(input.profileId)?.dto.authKinds[0];
            if (
              importing
                ? auth !== "oauth" || !permitsOAuthProfile(grant, input.profileId)
                : auth !== "api_key"
            ) {
              throw new KernelError("denied");
            }
            if (input.credential.kind === "oauth") {
              throw new KernelError("invalid");
            }
            requireCurrent(grant);
            uncertain = true;
            const command = {
              operationId: input.operationId,
              ownerRef: input.ownerRef,
              profile: input.profileId,
              displayName: input.displayName,
            };
            const op =
              input.credential.kind === "credential_import"
                ? await management.importAccount(context, {
                    ...command,
                    method: input.credential.method,
                    value: input.credential.value,
                  })
                : await management.create(context, { ...command, apiKey: input.credential.value });
            requireCurrent(grant);
            reply(
              c.accountOperation,
              await operationDTO(context, op),
              op.state === "pending" ? 202 : 200,
            );
            return;
          }
          const retirementMatch =
            /^\/v1\/accounts\/([A-Za-z0-9_-]+)\/retirement\/([A-Za-z0-9_-]+)$/.exec(path);
          if (retirementMatch) {
            if (method !== "GET") {
              throw new KernelError("invalid");
            }
            const ref = parse(c.reference, retirementMatch[1]);
            identity = { operationRef: parse(c.reference, retirementMatch[2]) };
            const account = await management.account(context, ref);
            if (!permitsOwner(grant, account.ownerRef) || !permitsProfile(grant, account.profile)) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            const readback = await management.retirement(context, ref, identity.operationRef!);
            requireCurrent(grant);
            reply(c.accountRetirement, retirementDTO(readback));
            return;
          }
          const accountMatch = /^\/v1\/accounts\/([A-Za-z0-9_-]+)(?:\/(reconnect|disable))?$/.exec(
            path,
          );
          if (accountMatch) {
            const ref = parse(c.reference, accountMatch[1]);
            const account = await management.account(context, ref);
            if (!permitsOwner(grant, account.ownerRef) || !permitsProfile(grant, account.profile)) {
              throw new KernelError("denied");
            }
            if (method === "GET" && !accountMatch[2]) {
              if (account.state === "suspended") {
                throw new KernelError("conflict");
              }
              reply(c.account, accountDTO(account));
              return;
            }
            if (method === "PATCH" && !accountMatch[2]) {
              const input = parse(c.rename, strictJSON(await body(req, ingressBytes), true));
              identity = { operationRef: input.operationId };
              requireCurrent(grant);
              uncertain = true;
              reply(
                c.accountOperation,
                await operationDTO(
                  context,
                  await management.rename(context, {
                    operationId: input.operationId,
                    accountRef: ref,
                    expectedRevision: input.expectedMetadataRevision,
                    displayName: input.displayName,
                  }),
                ),
              );
              return;
            }
            if (method === "POST" && accountMatch[2] === "disable") {
              const input = parse(c.disable, strictJSON(await body(req, ingressBytes), true));
              identity = { operationRef: input.operationId };
              requireCurrent(grant);
              uncertain = true;
              reply(
                c.accountOperation,
                await operationDTO(
                  context,
                  await management.disable(context, {
                    operationId: input.operationId,
                    accountRef: ref,
                    expectedRevision: input.expectedMetadataRevision,
                  }),
                ),
              );
              return;
            }
            if (method === "POST" && accountMatch[2] === "reconnect") {
              const profile = profiles.get(account.profile);
              const bytes = await body(req, Math.max(ingressBytes, 400 * 1024));
              const raw = strictJSON(bytes, true);
              if (profile?.nativeProfile) {
                const credential = secretSubmission.reconnect.safeParse(raw);
                if (credential.success) {
                  const input = credential.data;
                  if (input.credential.kind === "oauth") {
                    throw new KernelError("invalid");
                  }
                  const kind: LegacyConnectionKind =
                    input.credential.kind === "api_key"
                      ? "api_key"
                      : `credential_import:${input.credential.method}`;
                  const selection = legacySelection(account.profile, kind, "reconnect");
                  if (!nonempty(selection.inputFieldId)) {
                    throw new KernelError("denied");
                  }
                  identity = { operationRef: input.operationId };
                  requireCurrent(grant);
                  uncertain = true;
                  const result = await management.reconnectConnection(context, {
                    operationId: input.operationId,
                    accountRef: ref,
                    expectedRevision: input.expectedMetadataRevision,
                    snapshot: selection.snapshot,
                    legacyConnectionKind: selection.legacyConnectionKind,
                    inputFields: { [selection.inputFieldId]: input.credential.value },
                  });
                  reply(
                    c.accountOperation,
                    await operationDTO(context, result.operation),
                    result.operation.state === "pending" ? 202 : 200,
                  );
                } else {
                  const input = parse(c.oauthReconnect, raw);
                  const selection = legacySelection(
                    account.profile,
                    input.method === "device_code" ? "device_code" : "browser",
                    "reconnect",
                  );
                  identity = { operationRef: input.operationId };
                  requireCurrent(grant);
                  uncertain = true;
                  await replyOAuthBegin(
                    await management.reconnectConnection(context, {
                      operationId: input.operationId,
                      accountRef: ref,
                      expectedRevision: input.expectedMetadataRevision,
                      snapshot: selection.snapshot,
                      legacyConnectionKind: selection.legacyConnectionKind,
                    }),
                  );
                }
                return;
              }
              const credentialInput = secretSubmission.reconnect.safeParse(raw);
              if (
                credentialInput.success &&
                credentialInput.data.credential.kind === "credential_import"
              ) {
                const credential = credentialInput.data.credential,
                  input = credentialInput.data;
                if (bytes.length > 400 * 1024) {
                  throw new KernelError("invalid");
                }
                if (
                  profile?.dto.authKinds[0] !== "oauth" ||
                  !permitsOAuthProfile(grant, account.profile)
                ) {
                  throw new KernelError("denied");
                }
                identity = { operationRef: input.operationId };
                requireCurrent(grant);
                uncertain = true;
                const operation = await management.importReconnect(context, {
                  operationId: input.operationId,
                  accountRef: ref,
                  expectedRevision: input.expectedMetadataRevision,
                  method: credential.method,
                  value: credential.value,
                });
                requireCurrent(grant);
                reply(
                  c.accountOperation,
                  await operationDTO(context, operation),
                  operation.state === "pending" ? 202 : 200,
                );
                return;
              }
              if (profile?.dto.authKinds[0] === "oauth") {
                if (bytes.length > Math.min(ingressBytes, 16_384)) {
                  throw new KernelError("invalid");
                }
                const input = parse(c.oauthReconnect, raw);
                identity = { operationRef: input.operationId };
                if (
                  !management.supportsOAuthProfile(account.profile) ||
                  !permitsOAuthProfile(grant, account.profile)
                ) {
                  throw new KernelError("denied");
                }
                requireCurrent(grant);
                uncertain = true;
                const result = await management.beginOAuthReconnect(context, {
                  operationId: input.operationId,
                  accountRef: ref,
                  expectedRevision: input.expectedMetadataRevision,
                  method: input.method,
                });
                requireCurrent(grant);
                reply(
                  c.oauthBeginResponse,
                  {
                    operation: await operationDTO(context, result.operation),
                    ...(result.authorizationURL === undefined
                      ? {}
                      : { authorizationURL: result.authorizationURL }),
                    ...(result.deviceAuthorization === undefined
                      ? {}
                      : {
                          deviceAuthorization: c.oauthDeviceAuthorization.parse(
                            result.deviceAuthorization,
                          ),
                        }),
                  },
                  result.operation.state === "pending" ? 202 : 200,
                );
                return;
              }
              if (profiles.get(account.profile)?.dto.authKinds[0] !== "api_key") {
                throw new KernelError("denied");
              }
              if (bytes.length > ingressBytes) {
                throw new KernelError("invalid");
              }
              const input = parse(secretSubmission.reconnect, raw);
              identity = { operationRef: input.operationId };
              if (input.credential.kind !== "api_key") {
                throw new KernelError("invalid");
              }
              requireCurrent(grant);
              uncertain = true;
              reply(
                c.accountOperation,
                await operationDTO(
                  context,
                  await management.reconnect(context, {
                    operationId: input.operationId,
                    accountRef: ref,
                    expectedRevision: input.expectedMetadataRevision,
                    apiKey: input.credential.value,
                  }),
                ),
              );
              return;
            }
            throw new KernelError("invalid");
          }
          if (path === "/v1/executions" && method === "POST") {
            if (grant.role !== "management") {
              throw new KernelError("denied");
            }
            const input = parse(c.prepare, strictJSON(await body(req, ingressBytes), true));
            identity = { operationRef: input.operationId };
            const p = grant.preparation;
            if (
              input.subjectRef !== p.subjectRef ||
              input.policyRevision !== p.policyRevision ||
              input.bindingRevision !== p.bindingRevision ||
              input.profileId !== p.profileId ||
              !withinProfile(p.profileId, input.limits) ||
              input.limits.requestBytes > ingressBytes ||
              input.accountRefs.some((ref) => !p.accountRefs.includes(ref)) ||
              new Set(input.accountRefs).size !== input.accountRefs.length ||
              input.limits.concurrency > input.limits.requests ||
              Date.parse(input.deadline) <= Date.now() ||
              Date.parse(input.deadline) - Date.now() > p.maxRunMs ||
              (Object.keys(p.limits) as (keyof ApprovedLimits)[]).some(
                (key) => input.limits[key] > p.limits[key],
              )
            ) {
              throw new KernelError("denied");
            }
            const accounts: AccountStatus[] = [];
            for (const ref of input.accountRefs) {
              const a = await management.account(context, ref);
              if (!permitsOwner(grant, a.ownerRef) || a.profile !== p.profileId) {
                throw new KernelError("denied");
              }
              accounts.push(a);
            }
            limited = await options.admissionLimits?.screen(context, accounts);
            const issuer = await kernel.issuer(context);
            requireCurrent(grant);
            const tuple = [
              "account-gateway/facade-prepare/v1",
              context.consumerId,
              input.invocationRef,
              input.attemptRef,
              [...input.accountRefs],
              p.profileId,
              p.subjectRef,
              p.policyRevision,
              p.bindingRevision,
              issuer,
              input.deadline,
              input.limits.requests,
              input.limits.concurrency,
              input.limits.requestBytes,
              input.limits.outputBytes,
              input.limits.tokens,
            ];
            uncertain = true;
            const op = await kernel.prepare(context, {
              operationId: input.operationId,
              intentDigest: createHmac("sha256", hmac).update(JSON.stringify(tuple)).digest("hex"),
              invocationRef: input.invocationRef,
              attemptRef: input.attemptRef,
              permittedAccounts: input.accountRefs,
              profile: p.profileId,
              policySubject: p.subjectRef,
              policyRevision: p.policyRevision,
              bindingRevision: p.bindingRevision,
              issuerEpoch: issuer,
              deadline: new Date(input.deadline),
              limits: input.limits,
              limitedAccounts: limited?.limitedAccounts ?? [],
            });
            reply(c.preparationOperation, await operationDTO(context, op));
            return;
          }
          if (path === "/v1/policy-fences" && method === "POST") {
            const input = parse(c.fence, strictJSON(await body(req, ingressBytes), true));
            identity = { operationRef: input.operationId };
            if (
              grant.role === "management" &&
              (input.subjectRef !== grant.preparation.subjectRef ||
                input.revision < grant.preparation.policyRevision)
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            uncertain = true;
            reply(
              c.acknowledgementOperation,
              await operationDTO(
                context,
                await kernel.fence(context, input.operationId, input.subjectRef, input.revision),
              ),
            );
            return;
          }
          const policyClosureMatch = /^\/v1\/policy-fences\/([A-Za-z0-9_-]+)\/closure$/.exec(path);
          if (policyClosureMatch && method === "GET") {
            identity = { operationRef: parse(c.reference, policyClosureMatch[1]) };
            requireCurrent(grant);
            const readback = await management.policyClosure(context, identity.operationRef!);
            if (
              grant.role === "management" &&
              (readback.policySubject !== grant.preparation.subjectRef ||
                readback.policyRevision < grant.preparation.policyRevision)
            ) {
              throw new KernelError("denied");
            }
            requireCurrent(grant);
            reply(c.policyUseClosure, readback);
            return;
          }
          throw new KernelError("invalid");
        })()
          .catch(async (error: unknown) => {
            // The caller going away destroys the response first; that stop is not
            // a Gateway failure (native records it). Only a started response that
            // is still open when the facade cuts it gets a line.
            if (relayPhase !== undefined && res.headersSent && !res.destroyed) {
              emitStreamRelayFailure(relayPhase, error, identity.requestRef);
            }
            await markUnknown();
            if (res.headersSent || res.destroyed) {
              controller.abort();
              res.destroy();
              return;
            }
            if (error instanceof AccountsLimitedError && limited && !enteredTransport) {
              // The preparation transaction rolled back before any execution existed,
              // so this one refusal is definitely not dispatched despite `uncertain`.
              res.shouldKeepAlive = false;
              send(
                res,
                c.safeError,
                {
                  ...safe("admission_limited", "not_dispatched", identity),
                  retry: { kind: "after", milliseconds: limited.retryAfterMs(error.accountRefs) },
                },
                503,
              );
              return;
            }
            const code = error instanceof KernelError ? error.code : "unavailable";
            const dtoCode: c.SafeError["code"] =
              error instanceof FactCapacityError ||
              (error instanceof ServiceCapacityError && !enteredTransport && !uncertain)
                ? "admission_limited"
                : code === "invalid"
                  ? "invalid_request"
                  : code === "denied"
                    ? "forbidden"
                    : code === "conflict"
                      ? "conflict"
                      : code === "unknown"
                        ? "not_found"
                        : "upstream_failure";
            // No absence readback or transport exception is a non-entry receipt.
            res.shouldKeepAlive = false;
            send(
              res,
              c.safeError,
              {
                ...safe(
                  dtoCode,
                  enteredTransport || uncertain ? "effect_unknown" : "not_dispatched",
                  identity,
                ),
                ...(dtoCode === "upstream_failure" &&
                error instanceof KernelError &&
                error.providerQuota
                  ? { providerQuota: error.providerQuota }
                  : {}),
              },
              error instanceof FactCapacityError
                ? 503
                : code === "denied"
                  ? 403
                  : code === "invalid"
                    ? 400
                    : code === "conflict"
                      ? 409
                      : code === "unknown"
                        ? 404
                        : 503,
            );
          })
          .then(
            () => finishRequest().then((value) => value),
            (error: unknown) =>
              finishRequest().then(() => {
                throw error;
              }),
          ),
      )
        .finally(() => release?.())
        .catch(() => {});
    },
  );
  // Inspect the entire byte-bounded raw header set before applying the count
  // limit; Node's truncation must never hide a second Authorization field.
  server.maxHeadersCount = 0;
  server.maxConnections = 128;
  server.on("clientError", (_error, socket) => {
    const bytes = JSON.stringify(safe("invalid_request", "not_dispatched"));
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " +
        Buffer.byteLength(bytes) +
        "\r\n\r\n" +
        bytes,
    );
  });
  return server;
}
