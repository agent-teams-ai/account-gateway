import { nativeUsage } from "./usage.ts";
import type { NativeUsage } from "./usage.ts";
// Private Go v1 mapping. Public admission still belongs to the SDK contracts;
// these representations never enter public DTOs or consumer policy.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { KernelError, identifier, uuid, approvedLimits, defaults, instant } from "./domain.ts";
import type { NativeDispatchProof, PrivateAdmission, SavedExecution } from "./domain.ts";
import type { PhysicalCandidate } from "./management.ts";
import { strictJSON } from "./facade-ingress.ts";

export { instant };
export const denied = (): never => {
  throw new KernelError("denied");
};
export function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return denied();
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((k) => !keys.includes(k) && !optional.includes(k)) ||
    keys.some((k) => !Object.hasOwn(row, k))
  ) {
    return denied();
  }
  return row;
}
export const now = () => BigInt(Date.now()) * 1_000_000n;
export function admission(value: unknown): PrivateAdmission {
  const r = object(value, [
    "executionRef",
    "issuerEpoch",
    "invocationRef",
    "attemptRef",
    "accountRef",
    "authorizationEpoch",
    "subjectRef",
    "policyRevision",
    "bindingRevision",
    "profileId",
    "limits",
    "expiresAt",
  ]);
  uuid(r.executionRef);
  uuid(r.issuerEpoch);
  uuid(r.accountRef);
  for (const key of ["invocationRef", "attemptRef", "subjectRef", "profileId"]) {
    identifier(r[key]);
  }
  for (const key of ["authorizationEpoch", "policyRevision", "bindingRevision"]) {
    if (!Number.isSafeInteger(r[key]) || (r[key] as number) < 0) {
      return denied();
    }
  }
  instant(r.expiresAt);
  const limits = Object.freeze(
    approvedLimits(r.limits as PrivateAdmission["limits"], {
      ...defaults,
      maxRequests: 10_000,
      maxConcurrent: 128,
      maxRequestBytes: 4_194_304,
      maxOutputBytes: 8_388_608,
      maxTokens: 10_000_000,
    }),
  );
  return Object.freeze({ ...r, limits }) as unknown as PrivateAdmission;
}
export function saved(value: SavedExecution): SavedExecution {
  uuid(value.generation);
  if (
    !["open", "closed", "fenced"].includes(value.state) ||
    typeof value.dispatchAllowed !== "boolean"
  ) {
    return denied();
  }
  return Object.freeze({
    admission: admission(value.admission),
    generation: value.generation,
    state: value.state,
    dispatchAllowed: value.dispatchAllowed,
  });
}
export function sameAdmission(a: PrivateAdmission, b: PrivateAdmission): boolean {
  return Object.keys(a).every((k) =>
    k === "expiresAt"
      ? instant(a.expiresAt) === instant(b.expiresAt)
      : k === "limits"
        ? Object.keys(a.limits).every(
            (l) => a.limits[l as keyof typeof a.limits] === b.limits[l as keyof typeof b.limits],
          )
        : a[k as keyof PrivateAdmission] === b[k as keyof PrivateAdmission],
  );
}
export function binding(value: unknown): NativeDispatchProof["native"] {
  const r = object(value, ["originRef", "engineIncarnation", "requestNonce", "generation"]);
  identifier(r.originRef);
  identifier(r.engineIncarnation);
  uuid(r.requestNonce);
  uuid(r.generation);
  return Object.freeze({ ...r }) as unknown as NativeDispatchProof["native"];
}
export function proof(value: unknown): NativeDispatchProof {
  const r = object(value, ["executionRef", "requestRef", "worker", "token", "native"]);
  uuid(r.executionRef);
  identifier(r.requestRef);
  uuid(r.worker);
  identifier(r.token);
  return Object.freeze({ ...r, native: binding(r.native) }) as unknown as NativeDispatchProof;
}
export function sameProof(a: NativeDispatchProof, b: NativeDispatchProof): boolean {
  return (
    a.executionRef === b.executionRef &&
    a.requestRef === b.requestRef &&
    a.worker === b.worker &&
    a.token === b.token &&
    Object.keys(a.native).every(
      (k) => a.native[k as keyof typeof a.native] === b.native[k as keyof typeof b.native],
    )
  );
}
export interface Descriptor {
  account_id: number;
  generation: string;
  created_at: string;
  profile: string;
  base_url: string;
  model: string;
}
export function descriptor(p: PhysicalCandidate): Readonly<Descriptor> {
  return Object.freeze({
    account_id: p.nativeId,
    generation: p.generation,
    created_at: p.createdAt,
    profile: p.profile,
    base_url: p.baseURL,
    model: p.model,
  });
}
export function sameDescriptor(value: unknown, expected: Readonly<Descriptor>): boolean {
  const r = object(value, [
    "account_id",
    "generation",
    "created_at",
    "profile",
    "base_url",
    "model",
  ]);
  return Object.keys(expected).every((k) =>
    k === "created_at"
      ? instant(r[k]) === instant(expected.created_at)
      : r[k] === expected[k as keyof Descriptor],
  );
}
export interface CleanupLease {
  cleanupRef: string;
  worker: string;
  token: string;
  leaseExpiresAt: string;
}
export function cleanup(value: unknown): Readonly<CleanupLease> {
  const r = object(value, ["cleanupRef", "worker", "token", "leaseExpiresAt"]);
  uuid(r.cleanupRef);
  uuid(r.worker);
  uuid(r.token);
  instant(r.leaseExpiresAt);
  return Object.freeze({ ...r }) as unknown as CleanupLease;
}
export interface Receipt {
  nativeUsage?: NativeUsage;
  consumerId: string;
  executionRef: string;
  requestRef: string;
  native: NativeDispatchProof["native"];
  proof?: NativeDispatchProof;
  phase: string;
  effect: string;
  sealed: boolean;
  acknowledged: boolean;
  lifetime: {
    entered: boolean;
    contextDone: boolean;
    forwardingReturned: boolean;
    bodyKnown: boolean;
    bodyClosed: boolean;
    closeFailed: boolean;
    completed: boolean;
    sealed: boolean;
  };
}
function truthy(value: unknown): boolean {
  return Boolean(value);
}
export function receipt(value: unknown, consumer: string, p: NativeDispatchProof): Receipt {
  const r = object(
    value,
    [
      "consumerId",
      "executionRef",
      "requestRef",
      "native",
      "phase",
      "effect",
      "sealed",
      "acknowledged",
      "lifetime",
    ],
    ["proof", "status", "nativeUsage"],
  );
  if (
    r.consumerId !== consumer ||
    r.executionRef !== p.executionRef ||
    r.requestRef !== p.requestRef ||
    !truthy(r.proof) ||
    !sameProof(proof(r.proof), p) ||
    !sameProof({ ...p, native: binding(r.native) }, p) ||
    !["reserved", "admitted", "entered", "closed"].includes(r.phase as string) ||
    !["effect_unknown", "completed"].includes(r.effect as string) ||
    typeof r.sealed !== "boolean" ||
    typeof r.acknowledged !== "boolean"
  ) {
    return denied();
  }
  const lifetime = object(
    r.lifetime,
    [
      "entered",
      "contextDone",
      "forwardingReturned",
      "bodyKnown",
      "bodyClosed",
      "closeFailed",
      "completed",
      "sealed",
    ],
    ["outputBytes"],
  );
  for (const k of [
    "entered",
    "contextDone",
    "forwardingReturned",
    "bodyKnown",
    "bodyClosed",
    "closeFailed",
    "completed",
    "sealed",
  ]) {
    if (typeof lifetime[k] !== "boolean") {
      return denied();
    }
  }
  if (
    lifetime.outputBytes !== undefined &&
    (!Number.isSafeInteger(lifetime.outputBytes) || (lifetime.outputBytes as number) < 0)
  ) {
    return denied();
  }
  if (
    (truthy(lifetime.completed) && !truthy(lifetime.entered)) ||
    (r.effect === "completed") !== lifetime.completed
  ) {
    return denied();
  }
  if (r.status !== undefined) {
    const status = object(r.status, ["requestRef", "effect"], ["code"]);
    if (
      status.requestRef !== p.requestRef ||
      ![
        "not_dispatched",
        "dispatch_started",
        "response_started",
        "completed",
        "effect_unknown",
        "rejected_before_dispatch",
      ].includes(status.effect as string)
    ) {
      return denied();
    }
    if (status.code !== undefined) {
      identifier(status.code);
    }
  }
  return {
    ...r,
    lifetime,
    ...(r.nativeUsage === undefined ? {} : { nativeUsage: nativeUsage(r.nativeUsage) }),
  } as unknown as Receipt;
}
export function physicallyClosed(r: Receipt): boolean {
  const l = r.lifetime;
  return (
    r.phase === "closed" &&
    l.contextDone &&
    l.forwardingReturned &&
    l.bodyKnown &&
    l.bodyClosed &&
    !l.closeFailed
  );
}
export interface BridgeConsumer {
  consumerId: string;
  executionCredential: string;
  cleanupCredential: string;
  callbackCredential: string;
}
export interface BridgeConfig {
  origin: string;
  enrollment: {
    originRef: string;
    engineIncarnation: string;
    worker: string;
    qualificationRef: string;
  };
  consumers: readonly BridgeConsumer[];
  profiles: readonly {
    profile: string;
    baseURL: string;
    model: string;
    qualificationRef: string;
    requestBytes: number;
    outputBytes: number;
    tokens: number;
    providerTokenUpperBound: number;
  }[];
  timeoutMs?: number;
  closureWaitMs?: number;
  maxStreamMs?: number;
  maxPending?: number;
  controlBytes?: number;
}
export function config(input: BridgeConfig) {
  const parseURL = (value: string): URL => {
    try {
      return new URL(value);
    } catch {
      return denied();
    }
  };
  const origin = parseURL(input.origin);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    origin.href.length > 2048 ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname))
    )
  ) {
    return denied();
  }
  const enrollment = Object.freeze({ ...input.enrollment });
  identifier(enrollment.originRef);
  identifier(enrollment.engineIncarnation);
  identifier(enrollment.qualificationRef);
  uuid(enrollment.worker);
  if (
    !input.consumers.length ||
    input.consumers.length > 128 ||
    !input.profiles.length ||
    input.profiles.length > 16
  ) {
    return denied();
  }
  const tokens = new Set<string>(),
    consumers = input.consumers.map((c) => {
      identifier(c.consumerId);
      for (const t of [c.executionCredential, c.cleanupCredential, c.callbackCredential]) {
        if (
          typeof t !== "string" ||
          t.length > 1024 ||
          !/^[A-Za-z0-9._~+/-]{16,1024}=*$/.test(t) ||
          tokens.has(t)
        ) {
          return denied();
        }
        tokens.add(t);
      }
      return Object.freeze({ ...c });
    });
  if (new Set(consumers.map((c) => c.consumerId)).size !== consumers.length) {
    return denied();
  }
  const profiles = input.profiles.map((p) => {
    identifier(p.profile);
    identifier(p.qualificationRef);
    const url = parseURL(p.baseURL);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      p.baseURL.length > 2048 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(p.model) ||
      p.qualificationRef !== enrollment.qualificationRef
    ) {
      return denied();
    }
    for (const [v, cap] of [
      [p.requestBytes, 4_194_304],
      [p.outputBytes, 8_388_608],
      [p.tokens, 10_000_000],
      [p.providerTokenUpperBound, 10_000_000],
    ]) {
      if (!Number.isSafeInteger(v) || v < 1 || v > cap) {
        return denied();
      }
    }
    if (p.tokens > p.providerTokenUpperBound) {
      return denied();
    }
    return Object.freeze({ ...p });
  });
  if (new Set(profiles.map((p) => p.profile)).size !== profiles.length) {
    return denied();
  }
  const caps = {
    timeoutMs: input.timeoutMs ?? 5000,
    closureWaitMs: input.closureWaitMs ?? 1000,
    maxStreamMs: input.maxStreamMs ?? 3_600_000,
    maxPending: input.maxPending ?? 256,
    controlBytes: input.controlBytes ?? 32_768,
  };
  for (const [k, max] of Object.entries({
    timeoutMs: 30_000,
    closureWaitMs: 30_000,
    maxStreamMs: 86_400_000,
    maxPending: 10_000,
    controlBytes: 262_144,
  })) {
    if (
      !Number.isSafeInteger(caps[k as keyof typeof caps]) ||
      caps[k as keyof typeof caps] < 1 ||
      caps[k as keyof typeof caps] > max
    ) {
      return denied();
    }
  }
  return Object.freeze({
    origin: origin.origin,
    enrollment,
    consumers: Object.freeze(consumers),
    profiles: Object.freeze(profiles),
    ...caps,
  });
}
export type Configuration = ReturnType<typeof config>;
// One fresh connection and one POST. Node core does not follow redirects or
// consult HTTP proxy environment variables; normal TLS certificate checks apply.
export async function post(
  cfg: Configuration,
  credential: string,
  path: string,
  body: Uint8Array,
  signal?: AbortSignal,
  duration = cfg.timeoutMs,
): Promise<{ response: IncomingMessage; abort(): void; dispose(): void }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, cfg.origin);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      agent: false,
      maxHeaderSize: 16_384,
      signal,
      headers: {
        authorization: "Bearer " + credential,
        "content-type": "application/json",
        accept: "application/json",
        "content-length": body.byteLength,
      },
    });
    const timer = setTimeout(() => req.destroy(new KernelError("unavailable")), duration);
    req.setTimeout(duration, () => req.destroy(new KernelError("unavailable")));
    req.once("error", () => {
      clearTimeout(timer);
      reject(new KernelError("unavailable"));
    });
    req.once("response", (response) => {
      response.on("error", () => {});
      resolve({
        response,
        abort: () => {
          response.destroy();
          req.destroy();
          clearTimeout(timer);
        },
        dispose: () => {
          clearTimeout(timer);
        },
      });
    });
    req.end(body);
  });
}
export function singleton(message: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    if (message.rawHeaders[i].toLowerCase() === name) {
      values.push(message.rawHeaders[i + 1]);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}
export async function jsonBody(message: IncomingMessage, cap: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const b = Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > cap) {
      message.destroy();
      return denied();
    }
    chunks.push(b);
  }
  return strictJSON(Buffer.concat(chunks), true);
}
