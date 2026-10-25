import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { createHash } from "node:crypto";
import { approvedLimits, boundedFacts, defaults, identifier, integer } from "./domain.ts";
import type { ApprovedLimits, DurableFactBounds } from "./domain.ts";
import { FacadeBearers, RUN_CONTROL_MAX_RUN_MS, lifecycleContract } from "./facade.ts";
import type { ManagementBearer, RunControlBearer, ConsumerControlBearer } from "./facade.ts";
import { strictJSON } from "./facade-ingress.ts";
import { object } from "./native-wire.ts";
import { physicalCandidate, codexOAuthProfile, claudeOAuthProfile } from "./management.ts";
import { grokOAuthProfile } from "./oauth-profiles.ts";
import { providerConnectionDefinition } from "./provider-connections.ts";

export class ServiceError extends Error {
  readonly code: "config_denied" | "startup_denied" | "runtime_denied" | "shutdown_pending";
  constructor(code: ServiceError["code"]) {
    super(code);
    this.code = code;
  }
}
export interface ServiceConfig {
  readonly kernelDSN: string;
  // Required operator input; implementation defaults are not qualified caps.
  readonly durableFacts: Readonly<DurableFactBounds>;
  readonly facadeOrigin: string;
  readonly callbackOrigin: string;
  readonly native: Readonly<{
    executable: string;
    sha256: string;
    bootstrapFile: string;
    authorityDir: string;
    origin: string;
    originRef: string;
    uid: number;
    gid: number;
  }>;
  readonly consumer: Readonly<{
    consumerId: string;
    managementCredential: string;
    executionCredential: string;
    cleanupCredential: string;
    callbackCredential: string;
  }>;
  readonly profile: ServiceProfile;
  readonly secondProfile?: ServiceProfile;
  readonly providerProfiles?: readonly ServiceProfile[];
  readonly bearers: readonly (ManagementBearer | RunControlBearer | ConsumerControlBearer)[];
  readonly keys: Readonly<{ intentAEAD: string; intentHMAC: string; facadeHMAC: string }>;
  // Explicit opt-in with its own qualification and limits, captured before IO.
  readonly oauthEnrollment?: OAuthEnrollmentConfig;
  readonly claudeOAuthEnrollment?: ClaudeOAuthEnrollmentConfig;
  readonly grokOAuthEnrollment?: GrokOAuthEnrollmentConfig;
  readonly accountLifecycle?: Readonly<{
    contract: typeof lifecycleContract;
    writeGate: "enabled" | "disabled";
  }>;
}
export interface OAuthEnrollmentConfig {
  readonly enabled: true;
  readonly profile: "openai-codex-oauth-responses-v1";
  readonly modelScope: readonly ["gpt-5.6-sol"];
  readonly qualificationRef?: string;
  readonly limits?: Readonly<ApprovedLimits>;
  readonly providerTokenUpperBound?: number;
}
export interface ClaudeOAuthEnrollmentConfig extends Omit<
  OAuthEnrollmentConfig,
  "profile" | "modelScope"
> {
  readonly profile: "anthropic-claude-oauth-messages-v1";
  readonly modelScope: readonly ["claude-sonnet-4-6"];
}
export interface GrokOAuthEnrollmentConfig extends Omit<
  OAuthEnrollmentConfig,
  "profile" | "modelScope"
> {
  readonly profile: "grok-subscription-responses-oauth-v1";
  readonly modelScope: readonly ["grok-4.7"];
  readonly deploymentQualified: true;
  readonly clientId: string;
  readonly authorizationOrigin: "https://auth.x.ai";
  readonly redirectPolicy: "manual_loopback";
  readonly redirectURI: "http://127.0.0.1:56121/callback";
}
export interface ServiceProfile {
  readonly profile: string;
  readonly model: string;
  readonly baseURL: string;
  readonly qualificationRef: string;
  readonly limits: Readonly<ApprovedLimits>;
  readonly providerTokenUpperBound: number;
}
export const openRouterProfile = Object.freeze({
  profile: "openrouter-openai-responses-apikey-v1",
  baseURL: "https://openrouter.ai/api/v1",
  model: "openai/gpt-5.4-mini",
});
export const kimiProfile = Object.freeze({
  profile: "kimi-code-global-responses-apikey-v1",
  baseURL: "https://api.kimi.ai/coding/v1",
  model: "k3-256k",
});
export const glmProfile = Object.freeze({
  profile: "glm-coding-global-responses-apikey-v1",
  baseURL: "https://api.z.ai/api/v1",
  model: "glm-5.3-flash",
});
export const minimaxProfile = Object.freeze({
  profile: "minimax-mplan-global-responses-apikey-v1",
  baseURL: "https://api.minimax.io/v1",
  model: "MiniMax-M3.1-Flash",
});
const deny = (): never => {
  throw new ServiceError("config_denied");
};
function text(v: unknown): string {
  if (typeof v !== "string") return deny();
  return v;
}
function path(v: unknown): string {
  const p = text(v);
  if (!isAbsolute(p) || normalize(p) !== p || p.includes("\0")) return deny();
  return p;
}
// Protected ancestors prevent replacement between validation and native exec.
function protectedPath(p: string, kind: "file" | "directory" | "executable"): void {
  for (let a = dirname(p); ; a = dirname(a)) {
    const s = lstatSync(a);
    if (!s.isDirectory() || s.uid !== 0 || s.mode & 0o022) deny();
    if (a === "/") break;
  }
  const s = lstatSync(p);
  if (s.uid !== 0 || s.mode & 0o022) deny();
  if (kind === "directory") {
    if (!s.isDirectory() || (s.mode & 0o777) !== 0o700) deny();
  } else if (
    !s.isFile() ||
    s.nlink !== 1 ||
    (kind === "file" ? (s.mode & 0o777) !== 0o600 : !(s.mode & 0o100))
  )
    deny();
}
export function keyBytes(s: string): Buffer {
  const b = Buffer.from(s, "base64");
  if (b.length !== 32 || b.toString("base64") !== s) return deny();
  return b;
}
function origin(v: unknown): string {
  const s = text(v),
    u = new URL(s);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.origin !== s ||
    Number(u.port) < 1024 ||
    u.username ||
    u.password
  )
    return deny();
  return s;
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
// No caller/provider endpoint override or inferred alias; API-key profile stays
// the service default. Catalog evidence alone cannot enable a native account.
function captureEnrollmentConfig(
  value: unknown,
  profile: { readonly profile: string; readonly model: string; readonly baseURL: string },
) {
  try {
    const r = object(
      value,
      ["enabled", "profile", "modelScope"],
      ["qualificationRef", "limits", "providerTokenUpperBound"],
    );
    if (
      r.enabled !== true ||
      r.profile !== profile.profile ||
      !Array.isArray(r.modelScope) ||
      r.modelScope.length !== 1 ||
      r.modelScope[0] !== profile.model
    )
      return deny();
    const supplied = ["qualificationRef", "limits", "providerTokenUpperBound"].filter((k) =>
      Object.hasOwn(r, k),
    );
    if (supplied.length && supplied.length !== 3) return deny();
    const qualified = supplied.length
      ? captureProfile({
          ...profile,
          qualificationRef: r.qualificationRef,
          limits: r.limits,
          providerTokenUpperBound: r.providerTokenUpperBound,
        })
      : undefined;
    return Object.freeze({
      enabled: true,
      profile: profile.profile,
      modelScope: Object.freeze([profile.model]),
      ...(qualified
        ? {
            qualificationRef: qualified.qualificationRef,
            limits: qualified.limits,
            providerTokenUpperBound: qualified.providerTokenUpperBound,
          }
        : {}),
    });
  } catch {
    return deny();
  }
}
export function captureOAuthEnrollmentConfig(value: unknown): OAuthEnrollmentConfig {
  return captureEnrollmentConfig(value, codexOAuthProfile) as OAuthEnrollmentConfig;
}
export function captureClaudeOAuthEnrollmentConfig(value: unknown): ClaudeOAuthEnrollmentConfig {
  const config = captureEnrollmentConfig(value, claudeOAuthProfile) as ClaudeOAuthEnrollmentConfig;
  if ((config.limits?.tokens ?? 0) > 65_536 || (config.providerTokenUpperBound ?? 0) > 65_536)
    return deny();
  return config;
}
export function captureGrokOAuthEnrollmentConfig(value: unknown): GrokOAuthEnrollmentConfig {
  try {
    const r = object(
      value,
      [
        "enabled",
        "profile",
        "modelScope",
        "deploymentQualified",
        "clientId",
        "authorizationOrigin",
        "redirectPolicy",
        "redirectURI",
      ],
      ["qualificationRef", "limits", "providerTokenUpperBound"],
    );
    const base = captureEnrollmentConfig(
      {
        enabled: r.enabled,
        profile: r.profile,
        modelScope: r.modelScope,
        ...(r.qualificationRef === undefined ? {} : { qualificationRef: r.qualificationRef }),
        ...(r.limits === undefined ? {} : { limits: r.limits }),
        ...(r.providerTokenUpperBound === undefined
          ? {}
          : { providerTokenUpperBound: r.providerTokenUpperBound }),
      },
      grokOAuthProfile,
    );
    if (
      r.deploymentQualified !== true ||
      r.clientId !== text(r.clientId) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(r.clientId) ||
      r.authorizationOrigin !== "https://auth.x.ai" ||
      r.redirectPolicy !== "manual_loopback" ||
      r.redirectURI !== "http://127.0.0.1:56121/callback"
    )
      return deny();
    return Object.freeze({
      ...base,
      profile: "grok-subscription-responses-oauth-v1" as const,
      modelScope: Object.freeze(["grok-4.7"] as ["grok-4.7"]),
      deploymentQualified: true as const,
      clientId: r.clientId,
      authorizationOrigin: "https://auth.x.ai" as const,
      redirectPolicy: "manual_loopback" as const,
      redirectURI: "http://127.0.0.1:56121/callback" as const,
    });
  } catch {
    return deny();
  }
}
export function captureAccountLifecycle(
  value: unknown,
): NonNullable<ServiceConfig["accountLifecycle"]> {
  try {
    const r = object(value, ["contract", "writeGate"]);
    if (
      r.contract !== lifecycleContract ||
      (r.writeGate !== "enabled" && r.writeGate !== "disabled")
    )
      return deny();
    return Object.freeze({ contract: lifecycleContract, writeGate: r.writeGate });
  } catch {
    return deny();
  }
}
function captureProfile(value: unknown): ServiceProfile {
  const p = object(value, [
    "profile",
    "model",
    "baseURL",
    "qualificationRef",
    "limits",
    "providerTokenUpperBound",
  ]);
  const profile = {
    profile: text(p.profile),
    model: text(p.model),
    baseURL: text(p.baseURL),
    qualificationRef: text(p.qualificationRef),
    limits: approvedLimits(
      object(p.limits, [
        "requests",
        "concurrency",
        "requestBytes",
        "outputBytes",
        "tokens",
      ]) as unknown as ApprovedLimits,
      defaults,
    ),
    providerTokenUpperBound: p.providerTokenUpperBound as number,
  };
  identifier(profile.qualificationRef);
  physicalCandidate({
    ...profile,
    generation: "00000000-0000-4000-8000-000000000001",
    nativePhysicalIdentity: "00000000-0000-4000-8000-000000000001",
    nativeId: 1,
    createdAt: "2000-01-01T00:00:00Z",
  });
  integer(profile.providerTokenUpperBound, 10_000_000);
  if (profile.limits.tokens > profile.providerTokenUpperBound) deny();
  const definition = providerConnectionDefinition(profile.profile);
  if (
    definition &&
    profile.profile !== "openai-responses-apikey-v1" &&
    (definition.baseURL !== profile.baseURL ||
      !definition.models.some((model) => model.modelId === profile.model))
  )
    deny();
  return freeze(profile);
}
// Pure server configuration capture is shared by startup and source HTTP tests.
// The singleton stays compatible; only the optional second tuple is fixed.
export function captureServiceProfiles(
  input: Pick<
    ServiceConfig,
    | "profile"
    | "secondProfile"
    | "providerProfiles"
    | "oauthEnrollment"
    | "claudeOAuthEnrollment"
    | "grokOAuthEnrollment"
  >,
): readonly ServiceProfile[] {
  try {
    const first = captureProfile(input.profile);
    if (
      first.profile !== "openai-responses-apikey-v1" &&
      !providerConnectionDefinition(first.profile)?.authMethods.includes("api_key")
    )
      return deny();
    const profiles = [first];
    if (input.secondProfile !== undefined) {
      const p = captureProfile(input.secondProfile);
      if (
        p.profile === first.profile ||
        p.profile !== openRouterProfile.profile ||
        p.baseURL !== openRouterProfile.baseURL ||
        (p.model !== openRouterProfile.model && p.model !== "openai/gpt-5.4-nano")
      )
        return deny();
      profiles.push(p);
    }
    if (input.providerProfiles !== undefined) {
      if (!Array.isArray(input.providerProfiles) || input.providerProfiles.length > 3)
        return deny();
      for (const raw of input.providerProfiles) {
        const p = captureProfile(raw);
        if (
          !new Set<string>([kimiProfile.profile, glmProfile.profile, minimaxProfile.profile]).has(
            p.profile,
          ) ||
          profiles.some((old) => old.profile === p.profile)
        )
          return deny();
        profiles.push(p);
      }
    }
    if (input.oauthEnrollment !== undefined) {
      const o = captureOAuthEnrollmentConfig(input.oauthEnrollment);
      if (!o.limits || !o.qualificationRef || !o.providerTokenUpperBound) return deny();
      profiles.push(
        captureProfile({
          ...codexOAuthProfile,
          qualificationRef: o.qualificationRef,
          limits: o.limits,
          providerTokenUpperBound: o.providerTokenUpperBound,
        }),
      );
    }
    if (input.claudeOAuthEnrollment !== undefined) {
      const o = captureClaudeOAuthEnrollmentConfig(input.claudeOAuthEnrollment);
      if (!o.limits || !o.qualificationRef || !o.providerTokenUpperBound) return deny();
      profiles.push(
        captureProfile({
          ...claudeOAuthProfile,
          qualificationRef: o.qualificationRef,
          limits: o.limits,
          providerTokenUpperBound: o.providerTokenUpperBound,
        }),
      );
    }
    if (input.grokOAuthEnrollment !== undefined) {
      const o = captureGrokOAuthEnrollmentConfig(input.grokOAuthEnrollment);
      if (!o.limits || !o.qualificationRef || !o.providerTokenUpperBound) return deny();
      profiles.push(
        captureProfile({
          ...grokOAuthProfile,
          qualificationRef: o.qualificationRef,
          limits: o.limits,
          providerTokenUpperBound: o.providerTokenUpperBound,
        }),
      );
    }
    return Object.freeze(profiles);
  } catch {
    return deny();
  }
}
export function captureServiceBearers(
  value: unknown,
  consumerId: string,
  profiles: readonly ServiceProfile[],
): ServiceConfig["bearers"] {
  try {
    if (!Array.isArray(value) || !value.length || value.length > 128) return deny();
    const bearers = value.map((value) => {
      const b = value as ManagementBearer | RunControlBearer | ConsumerControlBearer;
      const role = b.role;
      if (role === "consumer-control") {
        object(b, ["token", "role", "consumerId", "profileIds", "limits", "maxRunMs"]);
        const supplied = b.profileIds;
        if (!Array.isArray(supplied)) return deny();
        const length = supplied.length;
        if (length < 1 || length > 128) return deny();
        const profileIds = Array.from({ length }, (_, i) => supplied[i]);
        const limits = { ...b.limits };
        object(limits, ["requests", "concurrency", "requestBytes", "outputBytes", "tokens"]);
        return {
          role,
          profileIds,
          limits,
          token: b.token,
          consumerId: b.consumerId,
          maxRunMs: b.maxRunMs,
        };
      }
      if (b.role === "management") {
        object(
          b,
          [
            "token",
            "role",
            "consumerId",
            Object.hasOwn(b, "ownerScope") ? "ownerScope" : "ownerRefs",
            "preparation",
          ],
          ["profileIds"],
        );
        object(b.preparation, [
          "accountRefs",
          "subjectRef",
          "policyRevision",
          "bindingRevision",
          "profileId",
          "limits",
          "maxRunMs",
        ]);
      } else
        object(b, ["token", "role", "consumerId", "ownerRefs", "profileIds", "limits", "maxRunMs"]);
      return b;
    });
    const mapping = new FacadeBearers(bearers);
    const captured = bearers.map((b) => {
      const token = b.token;
      const grant = mapping.resolve(token);
      if (!grant || grant.role === "execution") return deny();
      return { token, ...grant };
    });
    for (const b of captured) {
      if (b.consumerId !== consumerId) deny();
      if (
        b.role === "management" &&
        b.profileIds !== undefined &&
        b.profileIds.some((id) => !profiles.some((p) => p.profile === id))
      )
        deny();
      const ids = b.role === "management" ? [b.preparation.profileId] : b.profileIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) deny();
      const grant = b.role === "management" ? b.preparation : b;
      // Consumer output is a budget envelope over its selected profiles. Each
      // admission still checks both the grant and the selected physical cap.
      const outputEnvelope =
        b.role === "consumer-control"
          ? Math.max(
              ...ids.map((id) => profiles.find((p) => p.profile === id)?.limits.outputBytes ?? 0),
            )
          : undefined;
      for (const id of ids) {
        const p = profiles.find((p) => p.profile === id);
        if (!p) return deny();
        approvedLimits(grant.limits, {
          ...defaults,
          maxRequests: p.limits.requests,
          maxConcurrent: p.limits.concurrency,
          maxRequestBytes: p.limits.requestBytes,
          maxOutputBytes: outputEnvelope ?? p.limits.outputBytes,
          maxTokens: p.limits.tokens,
        });
      }
      integer(grant.maxRunMs, b.role === "management" ? defaults.maxRunMs : RUN_CONTROL_MAX_RUN_MS);
    }
    return freeze(captured);
  } catch {
    return deny();
  }
}
// Sole entry: synchronous capture/validation before the first startup await.
// No provider credential or native custody bytes are read here.
export function loadServiceConfig(file: string): ServiceConfig {
  try {
    if (process.geteuid?.() !== 0) return deny();
    protectedPath(path(file), "file");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const s = fstatSync(fd);
      if (
        !s.isFile() ||
        s.uid !== 0 ||
        s.nlink !== 1 ||
        (s.mode & 0o777) !== 0o600 ||
        s.size > 65_536
      )
        return deny();
      bytes = Buffer.alloc(65_537);
      // readFileSync would permit growth after fstat; bounded positional read below.
      bytes = readBounded(fd, bytes);
    } finally {
      closeSync(fd);
    }
    const r = object(
      strictJSON(bytes),
      [
        "kernelDSN",
        "durableFacts",
        "facadeOrigin",
        "callbackOrigin",
        "native",
        "consumer",
        "profile",
        "bearers",
        "keys",
      ],
      [
        "oauthEnrollment",
        "claudeOAuthEnrollment",
        "grokOAuthEnrollment",
        "secondProfile",
        "providerProfiles",
        "accountLifecycle",
      ],
    );
    const accountLifecycle =
      r.accountLifecycle === undefined ? undefined : captureAccountLifecycle(r.accountLifecycle);
    const oauthEnrollment = Object.hasOwn(r, "oauthEnrollment")
      ? captureOAuthEnrollmentConfig(r.oauthEnrollment)
      : undefined;
    const claudeOAuthEnrollment = Object.hasOwn(r, "claudeOAuthEnrollment")
      ? captureClaudeOAuthEnrollmentConfig(r.claudeOAuthEnrollment)
      : undefined;
    const grokOAuthEnrollment = Object.hasOwn(r, "grokOAuthEnrollment")
      ? captureGrokOAuthEnrollmentConfig(r.grokOAuthEnrollment)
      : undefined;
    // Use the kernel's existing bound authority after exact protected parsing.
    // Missing, extra, nonnumeric or inconsistent values deny before startup IO.
    const durableFacts = boundedFacts(
      object(r.durableFacts, [
        "maxServiceFacts",
        "maxConsumerFacts",
        "maxAccountFacts",
        "workerSlots",
        "issuerSlots",
      ]) as unknown as DurableFactBounds,
    );
    const n = object(r.native, [
      "executable",
      "sha256",
      "bootstrapFile",
      "authorityDir",
      "origin",
      "originRef",
      "uid",
      "gid",
    ]);
    const c = object(r.consumer, [
      "consumerId",
      "managementCredential",
      "executionCredential",
      "cleanupCredential",
      "callbackCredential",
    ]);
    const k = object(r.keys, ["intentAEAD", "intentHMAC", "facadeHMAC"]);
    const native = {
      executable: path(n.executable),
      sha256: text(n.sha256),
      bootstrapFile: path(n.bootstrapFile),
      authorityDir: path(n.authorityDir),
      origin: origin(n.origin),
      originRef: text(n.originRef),
      uid: n.uid as number,
      gid: n.gid as number,
    };
    integer(native.uid, 4_294_967_294);
    integer(native.gid, 4_294_967_294);
    identifier(native.originRef);
    protectedPath(native.executable, "executable");
    protectedPath(native.bootstrapFile, "file");
    protectedPath(native.authorityDir, "directory");
    if (!/^[a-f0-9]{64}$/.test(native.sha256) || imageHash(native.executable) !== native.sha256)
      deny();
    const consumer = {
      consumerId: text(c.consumerId),
      managementCredential: text(c.managementCredential),
      executionCredential: text(c.executionCredential),
      cleanupCredential: text(c.cleanupCredential),
      callbackCredential: text(c.callbackCredential),
    };
    identifier(consumer.consumerId);
    const profile = captureProfile(r.profile),
      secondProfile = r.secondProfile === undefined ? undefined : captureProfile(r.secondProfile);
    if (r.providerProfiles !== undefined && !Array.isArray(r.providerProfiles)) return deny();
    const providerProfiles =
      r.providerProfiles === undefined ? undefined : r.providerProfiles.map(captureProfile);
    const profiles = captureServiceProfiles({
      profile,
      secondProfile,
      providerProfiles,
      oauthEnrollment,
      claudeOAuthEnrollment,
      grokOAuthEnrollment,
    });
    const keys = {
      intentAEAD: text(k.intentAEAD),
      intentHMAC: text(k.intentHMAC),
      facadeHMAC: text(k.facadeHMAC),
    };
    Object.values(keys).forEach(keyBytes);
    if (new Set(Object.values(keys)).size !== 3) deny();
    const bearers = captureServiceBearers(r.bearers, consumer.consumerId, profiles);
    const credentials = [
      consumer.managementCredential,
      consumer.executionCredential,
      consumer.cleanupCredential,
      consumer.callbackCredential,
      ...bearers.map((b) => b.token),
    ];
    if (
      credentials.some((t) => !/^[A-Za-z0-9._~-]{16,1024}$/.test(t)) ||
      new Set(credentials).size !== credentials.length
    )
      deny();
    const kernelDSN = text(r.kernelDSN),
      u = new URL(kernelDSN);
    if (!["postgres:", "postgresql:"].includes(u.protocol) || u.pathname.length < 2) deny();
    const facadeOrigin = origin(r.facadeOrigin),
      callbackOrigin = origin(r.callbackOrigin);
    if (new Set([facadeOrigin, callbackOrigin, native.origin]).size !== 3) deny();
    return freeze({
      kernelDSN,
      durableFacts,
      facadeOrigin,
      callbackOrigin,
      native,
      consumer,
      profile,
      bearers,
      keys,
      ...(secondProfile === undefined ? {} : { secondProfile }),
      ...(providerProfiles === undefined ? {} : { providerProfiles }),
      ...(accountLifecycle === undefined ? {} : { accountLifecycle }),
      ...(oauthEnrollment === undefined ? {} : { oauthEnrollment }),
      ...(claudeOAuthEnrollment === undefined ? {} : { claudeOAuthEnrollment }),
      ...(grokOAuthEnrollment === undefined ? {} : { grokOAuthEnrollment }),
    });
  } catch {
    return deny();
  }
}
function readBounded(fd: number, b: Buffer): Buffer {
  let size = 0,
    count: number;
  do {
    count = readSync(fd, b, size, b.length - size, size);
    size += count;
  } while (count && size < b.length);
  if (size > 65_536) return deny();
  return b.subarray(0, size);
}
function imageHash(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== 0 ||
      s.nlink !== 1 ||
      s.mode & 0o022 ||
      !(s.mode & 0o100) ||
      s.size > 134_217_728
    )
      return deny();
    const hash = createHash("sha256"),
      b = Buffer.alloc(65_536);
    let size = 0,
      n: number;
    while ((n = readSync(fd, b, 0, b.length, size)) > 0) {
      size += n;
      if (size > 134_217_728) return deny();
      hash.update(b.subarray(0, n));
    }
    if (size !== s.size) return deny();
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
