import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  AccountModelsRequest,
  AccountModels,
  AccountLimitsRequest,
  AccountLimitsCapabilities,
  AccountLimits,
  AccountLimitsV2,
  AccountLimitsV2Capabilities,
} from "@agent-teams/account-gateway/contracts";
import type { RetainedCustodyProof } from "./domain.ts";
import { KernelError, identifier, uuid } from "./domain.ts";
import type { NativeControlAdmission } from "./service-admission.ts";
import { secretSubmission } from "@agent-teams/account-gateway/http";
import {
  accountModelsRequest,
  accountModels,
  accountLimitsRequest,
  accountLimitsCapabilities,
  accountLimits,
  accountLimitsV2,
  accountLimitsV2Capabilities,
  codexOAuthAuthorizationURL,
  claudeOAuthAuthorizationURL,
  grokOAuthAuthorizationURL,
  oauthDeviceAuthorization,
} from "@agent-teams/account-gateway/contracts";
import {
  type RetainedCustodyVerifier,
  codexOAuthProfile,
  exactCandidate,
  physicalCandidate,
  type CandidateJournal,
  type CandidateMapping,
  type CandidateNative,
  type NativeReadback,
  type PhysicalCandidate,
  type OAuthScope,
  type OAuthEnrollmentNative,
  type OAuthReadback,
  type OAuthBeginReadback,
  type OAuthCallback,
  type OAuthMethod,
  type OAuthDescriptor,
  type OAuthDescriptorBoundary,
  type OAuthRefreshNative,
  type OAuthRefreshReadback,
  type OAuthLifecycleNative,
  type OAuthCleanupAuthority,
  type OAuthCleanupAction,
  type OAuthCleanupReadback,
} from "./management.ts";
import { oauthProfileDefinition, type OAuthProfileDefinition } from "./oauth-profiles.ts";

export type NativeFailureCode =
  | "unavailable"
  | "deadline"
  | "bounded"
  | "redirect"
  | "invalid_readback"
  | "denied";
export class NativeFailure extends Error {
  readonly code: NativeFailureCode;
  // Any request failure may be effected. HTTP status alone never asserts NoEffect.
  readonly classification = "uncertain";
  constructor(code: NativeFailureCode) {
    super(code);
    this.code = code;
  }
}
// Existing private Go wire, supplied at native source 16d621c2. This is not SDK v1.
const candidatesPath = "/private/native/v1/candidates";
function oauthMethodDenied(method: unknown): boolean {
  return method !== undefined && method !== "device_code" && method !== "browser";
}
function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k) && !optional.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  ) {
    throw new NativeFailure("invalid_readback");
  }
  return value as Record<string, unknown>;
}
function decode(bytes: Buffer, maximumDepth = 4): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // JSON.parse chooses the last duplicate. Reject decoded duplicate member names
  // (including escaped aliases) before accepting any physical identity or ACK.
  let position = 0;
  const space = (): void => {
    while (/\s/.test(text[position] ?? "") && position < text.length) {
      position++;
    }
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const c = text[position++];
      if (c === "\\") {
        position++;
      } else if (c === '"') {
        return JSON.parse(text.slice(start, position)) as string;
      }
    }
    throw new NativeFailure("invalid_readback");
  };
  const value = (depth: number): void => {
    space();
    if (depth > maximumDepth) {
      throw new NativeFailure("invalid_readback");
    }
    if (text[position] === "{") {
      if (depth > maximumDepth) {
        throw new NativeFailure("invalid_readback");
      }
      position++;
      space();
      const keys = new Set<string>();
      if (text[position] === "}") {
        position++;
        return;
      }
      while (position < text.length) {
        if (text[position] !== '"') {
          throw new NativeFailure("invalid_readback");
        }
        const key = string();
        if (keys.has(key)) {
          throw new NativeFailure("invalid_readback");
        }
        keys.add(key);
        space();
        if (text[position++] !== ":") {
          throw new NativeFailure("invalid_readback");
        }
        const start = position;
        value(depth + 1);
        if (key === "account_id") {
          const token = text.slice(start, position).trim();
          // Check the original Go integer token before JSON.parse can round it.
          if (!/^[1-9][0-9]*$/.test(token) || BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new NativeFailure("invalid_readback");
          }
        }
        space();
        const next = text[position++];
        if (next === "}") {
          return;
        }
        if (next !== ",") {
          throw new NativeFailure("invalid_readback");
        }
        space();
      }
      throw new NativeFailure("invalid_readback");
    }
    if (text[position] === "[") {
      position++;
      space();
      if (text[position] === "]") {
        position++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        const next = text[position++];
        if (next === "]") {
          return;
        }
        if (next !== ",") {
          throw new NativeFailure("invalid_readback");
        }
      }
    }
    if (text[position] === '"') {
      string();
      return;
    }
    const start = position;
    while (position < text.length && !/[\s,}]/.test(text[position])) {
      position++;
    }
    if (position === start) {
      throw new NativeFailure("invalid_readback");
    }
  };
  value(0);
  space();
  if (position !== text.length) {
    throw new NativeFailure("invalid_readback");
  }
  return JSON.parse(text) as unknown;
}
function readback(bytes: Buffer): NativeReadback {
  try {
    const r = object(decode(bytes), [
      "descriptor",
      "name",
      "state",
      "group_free",
      "schedulable",
      "probes_enabled",
    ]);
    const d = object(r.descriptor, [
      "account_id",
      "generation",
      "created_at",
      "profile",
      "base_url",
      "model",
    ]);
    if (
      typeof r.name !== "string" ||
      Buffer.byteLength(r.name) < 1 ||
      Buffer.byteLength(r.name) > 400 ||
      !["inactive", "active"].includes(r.state as string) ||
      r.group_free !== true ||
      r.schedulable !== false ||
      r.probes_enabled !== false
    ) {
      throw new NativeFailure("invalid_readback");
    }
    const descriptor = physicalCandidate({
      generation: d.generation as string,
      nativePhysicalIdentity: d.generation as string,
      nativeId: d.account_id as number,
      createdAt: d.created_at as string,
      profile: d.profile as string,
      baseURL: d.base_url as string,
      model: d.model as string,
    });
    return Object.freeze({ ...descriptor, state: r.state as "inactive" | "active" });
  } catch {
    throw new NativeFailure("invalid_readback");
  }
}
function wireDescriptor(d: PhysicalCandidate): object {
  return {
    account_id: d.nativeId,
    generation: d.generation,
    created_at: d.createdAt,
    profile: d.profile,
    base_url: d.baseURL,
    model: d.model,
  };
}
function oauthPhysical(
  value: unknown,
  generation: string,
  definition: OAuthProfileDefinition,
  cleanupOnly = false,
): PhysicalCandidate {
  const d = object(value, [
    "account_id",
    "generation",
    "created_at",
    "profile",
    "base_url",
    "model",
  ]);
  const native = physicalCandidate({
    nativeId: d.account_id as number,
    generation: d.generation as string,
    nativePhysicalIdentity: d.generation as string,
    createdAt: d.created_at as string,
    profile: d.profile as string,
    baseURL: d.base_url as string,
    model: d.model as string,
  });
  if (
    native.generation !== generation ||
    native.profile !== definition.profile ||
    native.baseURL !== definition.baseURL ||
    (cleanupOnly
      ? !definition.cleanupModels.includes(native.model)
      : native.model !== definition.model)
  ) {
    throw new NativeFailure("invalid_readback");
  }
  return native;
}
function oauthEndpoint(
  definition: OAuthProfileDefinition,
  action: "begin" | "read" | "complete" | "poll" | "descriptor" | "custody" | "cleanup" | "refresh",
): string {
  if (action === "refresh") {
    return definition.refreshPath;
  }
  return (
    definition.nativePath +
    (action === "begin"
      ? ""
      : "/" +
        (
          {
            complete: "complete",
            read: "read",
            poll: "poll",
            descriptor: "descriptor",
            custody: "custody",
            cleanup: "cleanup",
          } as const
        )[action])
  );
}
export interface NativeManagementOptions {
  readonly origin: string;
  readonly consumerId: string;
  readonly controlCredential: string;
  readonly deadlineMs?: number;
  readonly bodyBytes?: number;
  readonly headerBytes?: number;
  readonly admission?: NativeControlAdmission;
}
// One concrete bounded transport shared by the two private control adapters.
// It carries no enrollment policy and never performs a second HTTP attempt.
class NativeControlHTTP {
  readonly #origin: URL;
  readonly #consumer: string;
  readonly #control: string;
  readonly #deadlineMs: number;
  readonly #bodyBytes: number;
  readonly #headerBytes: number;
  readonly #admission?: NativeControlAdmission;
  constructor(options: NativeManagementOptions) {
    let origin: URL;
    try {
      origin = new URL(options.origin);
    } catch {
      throw new KernelError("invalid");
    }
    if (
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname))
      ) ||
      origin.pathname !== "/" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    ) {
      throw new KernelError("invalid");
    }
    identifier(options.consumerId);
    if (
      typeof options.controlCredential !== "string" ||
      options.controlCredential.length < 1 ||
      options.controlCredential.length > 2048 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(options.controlCredential)
    ) {
      throw new KernelError("invalid");
    }
    const deadlineMs = options.deadlineMs ?? 5000,
      bodyBytes = options.bodyBytes ?? 65_536,
      headerBytes = options.headerBytes ?? 16_384;
    if (
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 30_000 ||
      !Number.isInteger(bodyBytes) ||
      bodyBytes < 1 ||
      bodyBytes > 2 * 1024 * 1024 ||
      !Number.isInteger(headerBytes) ||
      headerBytes < 1024 ||
      headerBytes > 16_384
    ) {
      throw new KernelError("invalid");
    }
    this.#origin = origin;
    this.#consumer = options.consumerId;
    this.#control = options.controlCredential;
    this.#deadlineMs = deadlineMs;
    this.#bodyBytes = bodyBytes;
    this.#headerBytes = headerBytes;
    this.#admission = options.admission;
  }
  protected scope(
    scope: Pick<CandidateJournal, "consumerId" | "generation" | "accountRef" | "ownerRef">,
  ): void {
    if (scope.consumerId !== this.#consumer) {
      throw new NativeFailure("denied");
    }
    uuid(scope.generation);
    uuid(scope.accountRef);
    identifier(scope.ownerRef);
  }
  protected async call(
    method: "POST" | "GET" | "PUT",
    path: string,
    value?: unknown,
    deadlineMs = this.#deadlineMs,
  ): Promise<Buffer> {
    const deadline = Date.now() + Math.min(deadlineMs, this.#deadlineMs);
    let body: Buffer | undefined;
    try {
      body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
      if (body && body.length > (path.endsWith("/oauth/connect/complete") ? 32_768 : 16_384)) {
        throw new NativeFailure("bounded");
      }
    } catch {
      throw new NativeFailure("bounded");
    }
    let release: (() => void) | undefined;
    try {
      release = await this.#admission?.acquire(deadline);
    } catch {
      throw new NativeFailure("unavailable");
    }
    if (Date.now() >= deadline) {
      release?.();
      throw new NativeFailure("deadline");
    }
    return new Promise<Buffer>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: NativeFailure, bytes?: Buffer): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(bytes ?? Buffer.alloc(0));
        }
        req.destroy();
      };
      const send = this.#origin.protocol === "https:" ? httpsRequest : httpRequest;
      let req: ReturnType<typeof httpRequest>;
      try {
        req = send(this.#origin, {
          method,
          path,
          agent: false,
          maxHeaderSize: this.#headerBytes,
          headers: {
            authorization: "Bearer " + this.#control,
            accept: "application/json",
            connection: "close",
            ...(body
              ? { "content-type": "application/json", "content-length": String(body.length) }
              : {}),
          },
        });
      } catch {
        release?.();
        reject(new NativeFailure("unavailable"));
        return;
      }
      let physical = false;
      req.once("socket", (socket) => {
        physical = true;
        socket.once("close", () => release?.());
      });
      req.once("close", () => {
        if (!physical) {
          release?.();
        }
      });
      req.maxHeadersCount = 65;
      timer = setTimeout(
        () => {
          finish(new NativeFailure("deadline"));
        },
        Math.max(1, deadline - Date.now()),
      );
      req.on("error", () => {
        finish(new NativeFailure("unavailable"));
      });
      req.on("response", (res) => {
        // Retain one overflow sentinel beyond 64 pairs; Node truncates the rest.
        if (res.rawHeaders.length > 128) {
          finish(new NativeFailure("bounded"));
          res.destroy();
          req.destroy();
          return;
        }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(new NativeFailure(status >= 300 && status < 400 ? "redirect" : "unavailable"));
          res.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.#bodyBytes) {
            finish(new NativeFailure("bounded"));
            res.destroy();
            req.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        res.on("aborted", () => {
          finish(new NativeFailure("unavailable"));
        });
        res.on("error", () => {
          finish(new NativeFailure("unavailable"));
        });
        res.on("end", () => {
          finish(undefined, Buffer.concat(chunks));
        });
      });
      // No redirect handler, reuse agent, retry, provider route or consumer bearer.
      if (body) {
        req.end(body);
      } else {
        req.end();
      }
    });
  }
}
// Separate inert custody protocol. Metadata GET is intentionally insufficient.
export class NativeRetainedCustodyClient
  extends NativeControlHTTP
  implements RetainedCustodyVerifier
{
  async verify(input: CandidateMapping): Promise<RetainedCustodyProof> {
    this.scope(input);
    const d = physicalCandidate(input.descriptor);
    if (!exactCandidate(input, d) || d.nativePhysicalIdentity !== d.generation) {
      throw new NativeFailure("denied");
    }
    const definition = oauthProfileDefinition(d.profile);
    const oauth = !!definition;
    if (oauth) {
      identifier(input.operationId);
    }
    const request = {
      contract: "native-retained-custody/v1",
      owner_ref: input.ownerRef,
      account_ref: input.accountRef,
      descriptor: wireDescriptor(d),
      ...(oauth ? { operation: input.operationId, generation: input.generation } : {}),
    };
    const bytes = await this.call(
      oauth ? "POST" : "GET",
      definition
        ? oauthEndpoint(definition, "custody")
        : candidatesPath + "/" + d.generation + "/custody",
      request,
    );
    try {
      const r = object(
        decode(bytes),
        ["contract", "generation", "native", "credential_kinds", "retention", "proof"],
        oauth ? ["oauth_policy"] : [],
      );
      const native = oauthPhysicalOrAPI(r.native);
      const retention = object(r.retention, ["state", "credential"]);
      const proof = object(r.proof, ["authenticated"]);
      const kinds = r.credential_kinds;
      if (
        r.contract !== "native-retained-custody/v1" ||
        r.generation !== d.generation ||
        !samePhysical(d, native) ||
        !Array.isArray(kinds) ||
        kinds.length !== 1 ||
        kinds[0] !== (oauth ? "oauth" : "api_key") ||
        retention.state !== (oauth ? "inactive" : "active") ||
        retention.credential !== "retained" ||
        proof.authenticated !== true
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (oauth) {
        const policy = object(r.oauth_policy, ["provider_validity", "expired_but_refreshable"]);
        if (
          retention.state !== "inactive" ||
          policy.provider_validity !== "unasserted" ||
          ![
            "not-qualified-by-existing-policy",
            "not-due-by-existing-policy",
            "eligible-by-existing-policy",
          ].includes(policy.expired_but_refreshable as string)
        ) {
          throw new NativeFailure("invalid_readback");
        }
      }
      return Object.freeze({
        contract: "native-retained-custody/v1",
        generation: d.generation,
        nativePhysicalIdentity: d.nativePhysicalIdentity,
        credentialKinds: Object.freeze([oauth ? ("oauth" as const) : ("api_key" as const)]),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}
function oauthPhysicalOrAPI(value: unknown): PhysicalCandidate {
  const d = object(value, [
    "account_id",
    "generation",
    "created_at",
    "profile",
    "base_url",
    "model",
  ]);
  return physicalCandidate({
    nativeId: d.account_id as number,
    generation: d.generation as string,
    nativePhysicalIdentity: d.generation as string,
    createdAt: d.created_at as string,
    profile: d.profile as string,
    baseURL: d.base_url as string,
    model: d.model as string,
  });
}
function samePhysical(a: PhysicalCandidate, b: PhysicalCandidate): boolean {
  return (
    a.nativeId === b.nativeId &&
    a.generation === b.generation &&
    a.nativePhysicalIdentity === b.nativePhysicalIdentity &&
    a.createdAt === b.createdAt &&
    a.profile === b.profile &&
    a.baseURL === b.baseURL &&
    a.model === b.model
  );
}

export class NativeManagementClient extends NativeControlHTTP implements CandidateNative {
  async create(input: CandidateJournal, displayName: string, apiKey: string): Promise<void> {
    const scope = {
      consumerId: input.consumerId,
      generation: input.generation,
      accountRef: input.accountRef,
      ownerRef: input.ownerRef,
      profile: input.profile.profile,
    };
    this.scope(scope);
    uuid(scope.generation);
    uuid(scope.accountRef);
    identifier(scope.ownerRef);
    identifier(scope.profile, 64);
    if (
      typeof displayName !== "string" ||
      !displayName.isWellFormed() ||
      displayName.length < 1 ||
      displayName.length > 128 ||
      Buffer.byteLength(displayName) > 400 ||
      typeof apiKey !== "string" ||
      !apiKey.isWellFormed() ||
      Buffer.byteLength(apiKey) < 1 ||
      Buffer.byteLength(apiKey) > 4096 ||
      apiKey.trim() !== apiKey
    ) {
      throw new NativeFailure("bounded");
    }
    await this.call("POST", candidatesPath, {
      generation: scope.generation,
      profile: scope.profile,
      name: displayName,
      api_key: apiKey,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
    });
  }
  async read(input: CandidateJournal): Promise<readonly NativeReadback[]> {
    this.scope(input);
    const generation = input.generation;
    const result = readback(await this.call("GET", candidatesPath + "/" + generation));
    if (!exactCandidate(input, result)) {
      throw new NativeFailure("invalid_readback");
    }
    return Object.freeze([result]);
  }
  private descriptor(input: CandidateMapping): PhysicalCandidate {
    this.scope(input);
    const d = physicalCandidate(input.descriptor);
    if (
      d.generation !== input.generation ||
      d.nativePhysicalIdentity !== input.generation ||
      d.profile !== input.profile.profile ||
      d.baseURL !== input.profile.baseURL ||
      d.model !== input.profile.model
    ) {
      throw new NativeFailure("denied");
    }
    return d;
  }
  async setState(input: CandidateMapping, state: "active" | "inactive"): Promise<void> {
    const d = this.descriptor(input);
    if (!["active", "inactive"].includes(state)) {
      throw new NativeFailure("denied");
    }
    // The PUT ACK itself does not authorize promotion; orchestration uses an exact GET.
    const response = readback(
      await this.call("PUT", candidatesPath + "/" + d.generation, {
        descriptor: wireDescriptor(d),
        state,
      }),
    );
    if (
      response.state !== state ||
      response.generation !== d.generation ||
      response.nativeId !== d.nativeId ||
      response.createdAt !== d.createdAt ||
      response.profile !== d.profile ||
      response.baseURL !== d.baseURL ||
      response.model !== d.model
    ) {
      throw new NativeFailure("invalid_readback");
    }
  }
  async erase(input: CandidateMapping): Promise<void> {
    const d = this.descriptor(input);
    const bytes = await this.call("POST", candidatesPath + "/" + d.generation + "/erase", {
      descriptor: wireDescriptor(d),
    });
    try {
      const ack = object(decode(bytes), ["state", "credentials_erased"]);
      if (ack.state !== "tombstoned" || ack.credentials_erased !== true) {
        throw new NativeFailure("invalid_readback");
      }
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

// The trusted outer composition binds a concrete consumer AND original owner.
// Completed custody remains pending until separate exact descriptor readback.
export class NativeOAuthEnrollmentClient
  extends NativeControlHTTP
  implements OAuthEnrollmentNative, OAuthDescriptorBoundary, OAuthRefreshNative
{
  readonly #owner: string;
  readonly #definition: OAuthProfileDefinition;
  readonly #grokBrowserPolicy?: { readonly clientId: string; readonly redirectURI: string };
  constructor(
    options: NativeManagementOptions & {
      readonly ownerRef: string;
      readonly profileId?: string;
      readonly grokBrowserPolicy?: { readonly clientId: string; readonly redirectURI: string };
    },
  ) {
    super(options);
    identifier(options.ownerRef);
    this.#owner = options.ownerRef;
    const definition = oauthProfileDefinition(options.profileId ?? codexOAuthProfile.profile);
    if (!definition) {
      throw new KernelError("invalid");
    }
    this.#definition = definition;
    if (definition.family === "grok") {
      if (!options.grokBrowserPolicy) {
        throw new KernelError("invalid");
      }
      this.#grokBrowserPolicy = Object.freeze({ ...options.grokBrowserPolicy });
    }
  }
  private capture(input: OAuthScope): OAuthScope {
    const scope = Object.freeze({
      consumerId: input.consumerId,
      operationId: input.operationId,
      ownerRef: input.ownerRef,
      accountRef: input.accountRef,
      generation: input.generation,
    });
    this.scope(scope);
    identifier(scope.operationId);
    if (scope.ownerRef !== this.#owner) {
      throw new NativeFailure("denied");
    }
    return scope;
  }
  private wire(scope: OAuthScope): object {
    // Exact native input; no client, redirect, endpoint, profile, display name,
    // PKCE verifier or credential is accepted from the consumer. Completion
    // adds only the separately validated callback state/code to this tuple.
    return {
      operation: scope.operationId,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
      generation: scope.generation,
    };
  }
  private ack(bytes: Buffer, scope: OAuthScope, begin: boolean): OAuthBeginReadback {
    try {
      const r = object(
        decode(bytes),
        ["operation", "account_ref", "state"],
        begin
          ? ["outcome", "authorize_url", "device_authorization", "method"]
          : ["outcome", "method"],
      );
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        !["prepared", "entered", "completed", "expired", "unknown"].includes(r.state as string)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (
        (Object.hasOwn(r, "method") && r.method !== "device_code" && r.method !== "browser") ||
        (!this.#definition.deviceCode && r.method === "device_code")
      ) {
        throw new NativeFailure("invalid_readback");
      }
      // Native outcome is not a safe DTO or a no-effect receipt. Validate its
      // bounded primitive shape then discard; never reflect vendor diagnostics.
      if (
        Object.hasOwn(r, "outcome") &&
        (typeof r.outcome !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(r.outcome))
      ) {
        throw new NativeFailure("invalid_readback");
      }
      let authorizationURL: string | undefined;
      if (Object.hasOwn(r, "authorize_url")) {
        if (!begin || r.state !== "prepared" || r.method === "device_code") {
          throw new NativeFailure("invalid_readback");
        }
        const schema =
          this.#definition.family === "claude"
            ? claudeOAuthAuthorizationURL
            : this.#definition.family === "grok"
              ? grokOAuthAuthorizationURL
              : codexOAuthAuthorizationURL;
        const parsed = schema.safeParse(r.authorize_url);
        if (!parsed.success) {
          throw new NativeFailure("invalid_readback");
        }
        if (this.#grokBrowserPolicy) {
          const url = new URL(parsed.data);
          if (
            url.searchParams.get("client_id") !== this.#grokBrowserPolicy.clientId ||
            url.searchParams.get("redirect_uri") !== this.#grokBrowserPolicy.redirectURI
          ) {
            throw new NativeFailure("invalid_readback");
          }
        }
        authorizationURL = parsed.data;
      }
      let deviceAuthorization: OAuthBeginReadback["deviceAuthorization"];
      if (Object.hasOwn(r, "device_authorization")) {
        if (
          !this.#definition.deviceCode ||
          !begin ||
          r.state !== "prepared" ||
          r.method !== "device_code" ||
          authorizationURL !== undefined
        ) {
          throw new NativeFailure("invalid_readback");
        }
        const d = object(r.device_authorization, [
          "user_code",
          "verification_url",
          "expires_at",
          "interval_seconds",
        ]);
        const parsed = oauthDeviceAuthorization.safeParse({
          userCode: d.user_code,
          verificationURL: d.verification_url,
          expiresAt: d.expires_at,
          intervalSeconds: d.interval_seconds,
        });
        if (!parsed.success) {
          throw new NativeFailure("invalid_readback");
        }
        deviceAuthorization = Object.freeze(parsed.data);
      }
      return Object.freeze({
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        state: r.state as OAuthReadback["state"],
        ...(authorizationURL === undefined ? {} : { authorizationURL }),
        ...(deviceAuthorization === undefined ? {} : { deviceAuthorization }),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async begin(input: OAuthScope, method?: OAuthMethod): Promise<OAuthBeginReadback> {
    const scope = this.capture(input);
    if (oauthMethodDenied(method) || (method === "device_code" && !this.#definition.deviceCode)) {
      throw new NativeFailure("denied");
    }
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "begin"), {
        ...this.wire(scope),
        ...(method === undefined ? {} : { method }),
      }),
      scope,
      true,
    );
    if (
      method === "device_code"
        ? result.authorizationURL !== undefined
        : result.deviceAuthorization !== undefined
    ) {
      throw new NativeFailure("invalid_readback");
    }
    return result;
  }
  async poll(input: OAuthScope): Promise<OAuthReadback> {
    if (!this.#definition.deviceCode) {
      throw new NativeFailure("denied");
    }
    const scope = this.capture(input);
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "poll"), this.wire(scope)),
      scope,
      false,
    );
    return Object.freeze({
      operationId: result.operationId,
      accountRef: result.accountRef,
      state: result.state,
    });
  }
  async complete(input: OAuthScope, callback: OAuthCallback): Promise<OAuthReadback> {
    const scope = this.capture(input);
    let completion: OAuthCallback;
    if ("authorizationCode" in callback) {
      const authorizationCode = callback.authorizationCode;
      if (
        this.#definition.family !== "grok" ||
        !secretSubmission.grokOAuthAuthorizationCode.safeParse(authorizationCode).success
      ) {
        throw new NativeFailure("bounded");
      }
      completion = { authorizationCode };
    } else {
      const state = callback.state,
        code = callback.code;
      const codeSchema =
        this.#definition.family === "claude"
          ? secretSubmission.claudeOAuthCallbackCode
          : this.#definition.family === "grok"
            ? secretSubmission.grokOAuthAuthorizationCode
            : secretSubmission.oauthCallbackCode;
      if (
        !secretSubmission.oauthCallbackState.safeParse(state).success ||
        !codeSchema.safeParse(code).success
      ) {
        throw new NativeFailure("bounded");
      }
      completion = { state, code };
    }
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "complete"), {
        ...this.wire(scope),
        ...completion,
      }),
      scope,
      false,
    );
    return Object.freeze({
      operationId: result.operationId,
      accountRef: result.accountRef,
      state: result.state,
    });
  }
  async read(input: OAuthScope): Promise<OAuthReadback> {
    const scope = this.capture(input);
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "read"), this.wire(scope)),
      scope,
      false,
    );
    return Object.freeze({
      operationId: result.operationId,
      accountRef: result.accountRef,
      state: result.state,
    });
  }
  async refresh(input: OAuthScope): Promise<OAuthRefreshReadback> {
    const scope = this.capture(input);
    const bytes = await this.call(
      "POST",
      oauthEndpoint(this.#definition, "refresh"),
      this.wire(scope),
      5000,
    );
    try {
      const r = object(decode(bytes), ["operation", "account_ref", "state"], ["refresh_ref"]);
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        !["idle", "prepared", "entered", "completed", "unknown"].includes(r.state as string)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (Object.hasOwn(r, "refresh_ref")) {
        identifier(r.refresh_ref);
      }
      return Object.freeze({
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        state: r.state as OAuthRefreshReadback["state"],
        ...(Object.hasOwn(r, "refresh_ref") ? { refreshRef: r.refresh_ref as string } : {}),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async describe(input: OAuthScope): Promise<OAuthDescriptor> {
    const scope = this.capture(input);
    const bytes = await this.call(
      "POST",
      oauthEndpoint(this.#definition, "descriptor"),
      this.wire(scope),
    );
    try {
      const r = object(
        decode(bytes),
        ["operation", "account_ref", "state", "qualification"],
        ["native"],
      );
      if (r.operation !== scope.operationId || r.account_ref !== scope.accountRef) {
        throw new NativeFailure("invalid_readback");
      }
      const logical = { operationId: scope.operationId, accountRef: scope.accountRef };
      if (r.state === "staged" && r.qualification === "pending" && !Object.hasOwn(r, "native")) {
        return Object.freeze({ ...logical, state: "staged", qualification: "pending" });
      }
      if (r.state !== "staged" || r.qualification !== "controlled-source-v1") {
        throw new NativeFailure("invalid_readback");
      }
      const native = oauthPhysical(r.native, scope.generation, this.#definition);
      return Object.freeze({
        ...logical,
        state: "qualified",
        qualification: "controlled-source-v1",
        native,
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

// Purpose-bound cleanup credential is composed separately from connect/control.
export class NativeOAuthLifecycleClient extends NativeControlHTTP implements OAuthLifecycleNative {
  readonly #owner: string;
  readonly #definition: OAuthProfileDefinition;
  constructor(
    options: NativeManagementOptions & {
      readonly ownerRef: string;
      readonly profileId?: string;
      readonly grokBrowserPolicy?: { readonly clientId: string; readonly redirectURI: string };
    },
  ) {
    super(options);
    identifier(options.ownerRef);
    this.#owner = options.ownerRef;
    const definition = oauthProfileDefinition(options.profileId ?? codexOAuthProfile.profile);
    if (!definition) {
      throw new KernelError("invalid");
    }
    this.#definition = definition;
  }
  async cleanup(
    input: OAuthScope,
    authority: OAuthCleanupAuthority,
    action: OAuthCleanupAction,
  ): Promise<OAuthCleanupReadback> {
    const scope = Object.freeze({
      consumerId: input.consumerId,
      operationId: input.operationId,
      ownerRef: input.ownerRef,
      accountRef: input.accountRef,
      generation: input.generation,
    });
    const cleanupRef = authority.cleanupRef,
      cleanupToken = authority.cleanupToken;
    this.scope(scope);
    identifier(scope.operationId);
    uuid(cleanupRef);
    uuid(cleanupToken);
    if (scope.ownerRef !== this.#owner || !["read", "erase"].includes(action)) {
      throw new NativeFailure("denied");
    }
    const bytes = await this.call("POST", oauthEndpoint(this.#definition, "cleanup"), {
      operation: scope.operationId,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
      generation: scope.generation,
      action,
      cleanup_ref: cleanupRef,
      cleanup_token: cleanupToken,
    });
    try {
      const r = object(
        decode(bytes),
        ["operation", "account_ref", "credentials_erased", "closure"],
        ["native"],
      );
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        typeof r.credentials_erased !== "boolean" ||
        !["pending", "closed", "unknown"].includes(r.closure as string) ||
        (r.closure === "closed" && !r.credentials_erased)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      const native = Object.hasOwn(r, "native")
        ? oauthPhysical(r.native, scope.generation, this.#definition, true)
        : undefined;
      return Object.freeze({
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        credentialsErased: r.credentials_erased,
        closure: r.closure as OAuthCleanupReadback["closure"],
        ...(native ? { native } : {}),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** Cached source reads only; transport never retries or calls a provider. */
export class NativeAccountLimitsClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 3000, bodyBytes: 262144 });
  }
  async getAccountLimitsCapabilities(): Promise<AccountLimitsCapabilities> {
    try {
      return accountLimitsCapabilities.parse(
        decode(await this.call("GET", "/private/native/v1/account-limits/capabilities")),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async readAccountLimits(input: AccountLimitsRequest): Promise<AccountLimits> {
    try {
      return accountLimits.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v1/account-limits/read",
            accountLimitsRequest.parse(input),
          ),
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** v2 is selected by declared capability and is never probed alongside v1. */
export class NativeAccountLimitsV2Client extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 3000, bodyBytes: 262144 });
  }
  async getAccountLimitsCapabilities(): Promise<AccountLimitsV2Capabilities> {
    try {
      return accountLimitsV2Capabilities.parse(
        decode(await this.call("GET", "/private/native/v2/account-limits/capabilities")),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async readAccountLimits(input: AccountLimitsRequest): Promise<AccountLimitsV2> {
    try {
      return accountLimitsV2.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v2/account-limits/read",
            accountLimitsRequest.parse(input),
          ),
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** Bounded native catalogue read; no provider credentials cross this boundary. */
export class NativeAccountModelsClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 5000, bodyBytes: 2 * 1024 * 1024 });
  }
  async readAccountModels(input: AccountModelsRequest): Promise<AccountModels> {
    try {
      return accountModels.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v1/account-models/read",
            accountModelsRequest.parse(input),
          ),
          6,
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}
