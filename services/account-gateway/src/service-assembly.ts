import type { IncomingMessage, ServerResponse } from "node:http";
import {
  NativeControlAdmission,
  nativeCallbackCapacity,
  facadeBoundedReadRoute,
} from "./service-admission.ts";
import {
  KernelError,
  defaults,
  type Bounds,
  type CleanupClaim,
  type DurableKernel,
  type ExecutionRead,
  type TrustedContext,
} from "./domain.ts";
import {
  AccountManagement,
  exactCandidate,
  sameCandidate,
} from "./management.ts";
import type {
  CandidateJournal,
  CandidateNative,
  IntentCustody,
  ManagementStore,
  OAuthScope,
  OAuthCallback,
  OAuthCleanupAuthority,
  OAuthCleanupAction,
  OAuthMethod,
} from "./management.ts";
import { oauthProfileDefinition } from "./oauth-profiles.ts";
import { providerConnectionDefinition } from "./provider-connections.ts";
import {
  NativeAccountModelsClient,
  NativeAccountLimitsClient,
  NativeAccountLimitsRefreshClient,
  NativeAccountLimitsV2Client,
  NativeManagementClient,
  NativeRetainedCustodyClient,
  NativeOAuthEnrollmentClient,
  NativeOAuthLifecycleClient,
} from "./native-client.ts";
import { NativeAuthority } from "./native-authority.ts";
import { NativeHTTPTransport } from "./native-transport.ts";
import { FacadeBearers } from "./facade.ts";
import { NativeAdmissionLimits } from "./admission-limits.ts";
import type { ConfiguredBearer, FacadeOptions } from "./facade.ts";
import { captureServiceBearers, captureServiceProfiles } from "./service-config.ts";
import type { ServiceConfig, ServiceProfile } from "./service-config.ts";

type RunDurationBearer = Extract<
  ConfiguredBearer,
  { readonly role: "consumer-control" | "run-control" }
>;
function isRunDurationBearer(bearer: ConfiguredBearer): bearer is RunDurationBearer {
  return bearer.role === "consumer-control" || bearer.role === "run-control";
}
export function composeKernelBounds(
  bearers: readonly ConfiguredBearer[],
  profiles: readonly ServiceProfile[] = [],
): Bounds {
  const runDurationBearers = bearers.filter(isRunDurationBearer);
  const maxRunMs = runDurationBearers.reduce(
    (max, bearer) => Math.max(max, bearer.maxRunMs),
    defaults.maxRunMs,
  );
  const maxConcurrent = profiles.reduce(
    (max, profile) => Math.max(max, profile.limits.concurrency),
    defaults.maxConcurrent,
  );
  return Object.freeze({ ...defaults, maxRunMs, maxConcurrent });
}

// Retire a bounded batch of successful claims without sleeping between already
// closed executions. An unresolved claim ends the batch; every acquired batch
// yields the next serial tick to OAuth. The time budget limits starting more
// work, while each started claim retains its existing lease and wire deadlines.
export function composeServiceCleanupTurn(
  kernel: Pick<DurableKernel, "claimCleanup">,
  ctx: TrustedContext,
  worker: string,
  settle: (claim: CleanupClaim) => Promise<boolean>,
  signal?: AbortSignal,
) {
  let refreshTurn = false;
  const aborted = (): boolean => signal?.aborted === true;
  return async () => {
    if (refreshTurn) {
      refreshTurn = false;
      return false;
    }
    const started = performance.now();
    let acquired = false;
    for (let count = 0; count < 8 && !aborted(); count++) {
      if (count && performance.now() - started >= 1000) {
        break;
      }
      const claim = await kernel.claimCleanup(ctx, worker);
      if (!claim) {
        break;
      }
      acquired = refreshTurn = true;
      if (aborted() || !(await settle(claim))) {
        break;
      }
    }
    return acquired;
  };
}

// Bounded reads share one socket budget, independent of the native callback
// producer budget, so reads cannot occupy callback capacity while awaiting it.
export function protectedReadSockets(): (req: IncomingMessage, res: ServerResponse) => boolean {
  let occupied = 0;
  return (req, res) => {
    if (!facadeBoundedReadRoute(req.method, req.url)) {
      return true;
    }
    if (occupied >= nativeCallbackCapacity.usage) {
      res.writeHead(503, { connection: "close" });
      res.end();
      return false;
    }
    occupied++;
    req.socket.once("close", () => {
      occupied--;
    });
    return true;
  };
}

// Trusted composition only: AccountManagement reconstructs OAuthScope from its
// committed original journal. Each call binds a fresh fixed-owner client; no
// owner cache, caller factory, callback URL or bearer transfer is introduced.
export function composeServiceControl(
  cfg: Pick<
    ServiceConfig,
    | "native"
    | "consumer"
    | "profile"
    | "secondProfile"
    | "providerProfiles"
    | "oauthEnrollment"
    | "claudeOAuthEnrollment"
    | "grokOAuthEnrollment"
    | "bearers"
  >,
  kernel: DurableKernel & ExecutionRead,
  store: ManagementStore,
  custody: IntentCustody,
  worker: string,
  nativeControls?: NativeControlAdmission,
) {
  const profiles = captureServiceProfiles(cfg);
  const consumerId = cfg.consumer.consumerId;
  const bearers = new FacadeBearers(captureServiceBearers(cfg.bearers, consumerId, profiles));
  const control = {
    origin: cfg.native.origin,
    consumerId,
    controlCredential: cfg.consumer.managementCredential,
    admission: nativeControls,
  };
  const client = new NativeManagementClient(control);
  const checkProfile = (j: CandidateJournal) => {
    const p = profiles.find((profile) => profile.profile === j.profile.profile);
    if (
      !p ||
      oauthProfileDefinition(p.profile) ||
      j.consumerId !== consumerId ||
      j.profile.model !== p.model ||
      j.profile.baseURL !== p.baseURL ||
      j.profile.qualificationRef !== p.qualificationRef
    ) {
      throw new KernelError("denied");
    }
  };
  const native: CandidateNative = {
    create(j, name, key) {
      checkProfile(j);
      return client.create(j, name, key);
    },
    read(j) {
      checkProfile(j);
      return client.read(j);
    },
    setState(j, state) {
      checkProfile(j);
      return client.setState(j, state);
    },
    erase(j) {
      checkProfile(j);
      return client.erase(j);
    },
  };
  const oauthProviders = profiles
    .filter((p) => oauthProfileDefinition(p.profile))
    .map((profile) => {
      const forScope = (scope: OAuthScope) =>
        new NativeOAuthEnrollmentClient({
          ...control,
          ownerRef: scope.ownerRef,
          profileId: profile.profile,
          ...(profile.profile === cfg.grokOAuthEnrollment?.profile
            ? {
                grokBrowserPolicy: {
                  clientId: cfg.grokOAuthEnrollment.clientId,
                  redirectURI: cfg.grokOAuthEnrollment.redirectURI,
                },
              }
            : {}),
        });
      return {
        profile,
        native: {
          begin: (scope: OAuthScope, method?: OAuthMethod) => forScope(scope).begin(scope, method),
          read: (scope: OAuthScope) => forScope(scope).read(scope),
          poll: (scope: OAuthScope) => forScope(scope).poll(scope),
          complete: (scope: OAuthScope, callback: OAuthCallback) =>
            forScope(scope).complete(scope, callback),
        },
        descriptor: { describe: (scope: OAuthScope) => forScope(scope).describe(scope) },
        lifecycle: {
          cleanup: (
            scope: OAuthScope,
            authority: OAuthCleanupAuthority,
            action: OAuthCleanupAction,
          ) =>
            new NativeOAuthLifecycleClient({
              ...control,
              controlCredential: cfg.consumer.cleanupCredential,
              ownerRef: scope.ownerRef,
              profileId: profile.profile,
            }).cleanup(scope, authority, action),
        },
        refresh: { refresh: (scope: OAuthScope) => forScope(scope).refresh(scope) },
      };
    });
  const management = new AccountManagement({
    kernel,
    store,
    custody,
    native,
    worker,
    profiles: profiles.filter((p) => !oauthProfileDefinition(p.profile)),
    oauthProviders,
    retainedCustody: new NativeRetainedCustodyClient(control),
    proof: {
      async verify(j, d) {
        const p = profiles.find((profile) => profile.profile === j.profile.profile);
        const rows = await native.read(j);
        return (
          !!p &&
          rows.length === 1 &&
          rows[0].state === "inactive" &&
          exactCandidate(j, d) &&
          exactCandidate(j, rows[0]) &&
          sameCandidate(d, rows[0]) &&
          j.profile.model === p.model &&
          j.profile.baseURL === p.baseURL &&
          j.profile.qualificationRef === p.qualificationRef
        );
      },
    },
  });
  const catalog: FacadeOptions["profiles"] = Object.freeze(
    profiles.map((p) => ({
      dto: {
        profileId: p.profile,
        protocol:
          providerConnectionDefinition(p.profile)?.protocol ?? ("openai-responses" as const),
        modelIds: [p.model],
        authKinds: [oauthProfileDefinition(p.profile) ? ("oauth" as const) : ("api_key" as const)],
      },
      maxOutputTokens: p.limits.tokens,
      limits: p.limits,
    })),
  );
  return Object.freeze({
    profiles,
    bearers,
    management,
    catalog,
    nativeControls,
    accountModels: new NativeAccountModelsClient(control),
    accountLimits: new NativeAccountLimitsClient(control),
    accountLimitsRefresh: new NativeAccountLimitsRefreshClient(control),
    accountLimitsV2: new NativeAccountLimitsV2Client(control),
  });
}
/** Both facades and joined callers use the production cached-read wiring. */
export function composeServiceCachedLimits(
  control: Pick<
    ReturnType<typeof composeServiceControl>,
    "accountModels" | "accountLimits" | "accountLimitsV2" | "accountLimitsRefresh"
  >,
): Pick<
  FacadeOptions,
  "accountModels" | "accountLimits" | "accountLimitsV2" | "accountLimitsRefresh" | "admissionLimits"
> {
  return {
    accountModels: control.accountModels,
    accountLimits: control.accountLimits,
    accountLimitsRefresh: control.accountLimitsRefresh,
    accountLimitsV2: control.accountLimitsV2,
    // One read-through view shared by both facades; native stays the authority.
    admissionLimits: new NativeAdmissionLimits({ codex: control.accountLimits }),
  };
}
export function composeServiceNative(
  cfg: Pick<
    ServiceConfig,
    "native" | "consumer" | "oauthEnrollment" | "claudeOAuthEnrollment" | "grokOAuthEnrollment"
  >,
  control: ReturnType<typeof composeServiceControl>,
  kernel: DurableKernel & ExecutionRead,
  store: ManagementStore,
  enrollment: NonNullable<FacadeOptions["enrollment"]>,
  usage?: FacadeOptions["usage"],
) {
  const authority = new NativeAuthority({
    kernel,
    store,
    executionBearers: control.bearers,
    usage,
    accountLimitsOwners: { bearers: control.bearers },
    accountModels: control.accountModels,
    ...(cfg.oauthEnrollment || cfg.claudeOAuthEnrollment || cfg.grokOAuthEnrollment
      ? {
          oauthOwners: { store, bearers: control.bearers },
          oauthRefreshOwners: { store, bearers: control.bearers },
          oauthCleanupOwners: { store },
        }
      : {}),
    profileLimits: control.profiles.map((p) => ({ profile: p.profile, limits: p.limits })),
    config: {
      origin: cfg.native.origin,
      enrollment: { ...enrollment, qualificationRef: control.profiles[0].qualificationRef },
      consumers: [cfg.consumer],
      profiles: control.profiles.map((p) => ({
        ...p,
        requestBytes: p.limits.requestBytes,
        outputBytes: p.limits.outputBytes,
        tokens: p.limits.tokens,
      })),
      timeoutMs: 5000,
      closureWaitMs: 1000,
      maxPending: 128,
    },
  });
  return Object.freeze({
    authority,
    transport: new NativeHTTPTransport(authority, control.nativeControls),
  });
}

