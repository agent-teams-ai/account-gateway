// Server-owned bearer authority and revocation, separate from HTTP routing.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as c from "@agent-teams/account-gateway/contracts";
import { KernelError, identifier, uuid } from "./domain.ts";
import type {
  ApprovedLimits,
  ExecutionRead,
  PrivateAdmission,
  SavedExecution,
  TrustedContext,
} from "./domain.ts";
import { parse } from "./facade-contract-parse.ts";

export interface PreparationPolicy {
  readonly accountRefs: readonly string[];
  readonly subjectRef: string;
  readonly policyRevision: number;
  readonly bindingRevision: number;
  readonly profileId: string;
  readonly limits: ApprovedLimits;
  readonly maxRunMs: number;
}
export type ManagementBearer = {
  readonly token: string;
  readonly role: "management";
  readonly consumerId: string;
  readonly preparation: PreparationPolicy;
  // Absent retains management access to every configured profile.
  readonly profileIds?: readonly string[];
} & (
  | { readonly ownerRefs: readonly string[]; readonly ownerScope?: never }
  | { readonly ownerScope: "consumer"; readonly ownerRefs?: never }
);
export interface ExecutionBearer {
  readonly token: string;
  readonly role: "execution";
  readonly consumerId: string;
  // Supplied only by trusted backend composition from the persisted prepare.
  readonly saved: SavedExecution;
}
// A distinct RR backend credential, never an execution or management upgrade.
export interface RunControlBearer {
  readonly token: string;
  readonly role: "run-control";
  readonly consumerId: string;
  readonly ownerRefs: readonly string[];
  readonly profileIds: readonly string[];
  readonly limits: ApprovedLimits;
  readonly maxRunMs: number;
}
export interface ConsumerControlBearer {
  readonly token: string;
  readonly role: "consumer-control";
  readonly consumerId: string;
  readonly profileIds: readonly string[];
  readonly limits: ApprovedLimits;
  readonly maxRunMs: number;
}
export const RUN_CONTROL_MAX_RUN_MS = 21_600_000;
export interface RunAccess {
  readonly operation: c.Operation;
  readonly bearer: string;
  readonly admission: c.Admission;
}
export type ConfiguredBearer =
  | ManagementBearer
  | ExecutionBearer
  | RunControlBearer
  | ConsumerControlBearer;
type RunControlGrant = Omit<RunControlBearer, "token"> | Omit<ConsumerControlBearer, "token">;
type WithoutToken<T> = T extends unknown ? Omit<T, "token"> : never;
type AccountGrant = WithoutToken<ManagementBearer> | Omit<ConsumerControlBearer, "token">;
export type Grant = WithoutToken<ManagementBearer> | Omit<ExecutionBearer, "token"> | RunControlGrant;
export const permitsProfile = (grant: AccountGrant, profileId: string): boolean =>
  grant.profileIds === undefined || grant.profileIds.includes(profileId);
export const permitsOwner = (grant: AccountGrant, ownerRef: string): boolean =>
  grant.role === "consumer-control" ||
  grant.ownerScope === "consumer" ||
  grant.ownerRefs.includes(ownerRef);
export const permitsOAuthProfile = (grant: AccountGrant, profileId: string): boolean =>
  permitsProfile(grant, profileId) &&
  (grant.role !== "management" ||
    grant.ownerScope === "consumer" ||
    grant.preparation.profileId === profileId);
export function savedCopy(s: SavedExecution): SavedExecution {
  const a = s.admission;
  const wire = parse(c.admission, {
    invocationRef: a.invocationRef,
    attemptRef: a.attemptRef,
    accountRef: a.accountRef,
    authorizationEpoch: a.authorizationEpoch,
    subjectRef: a.subjectRef,
    policyRevision: a.policyRevision,
    bindingRevision: a.bindingRevision,
    profileId: a.profileId,
    limits: { ...a.limits },
    expiresAt: a.expiresAt,
  });
  uuid(a.executionRef);
  uuid(a.issuerEpoch);
  uuid(s.generation);
  Object.freeze(wire.limits);
  return Object.freeze({
    generation: s.generation,
    state: s.state,
    dispatchAllowed: s.dispatchAllowed,
    admission: Object.freeze({ ...wire, executionRef: a.executionRef, issuerEpoch: a.issuerEpoch }),
  });
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest();
// Configured authorities are bounded. Issued execution locators retain no
// registry entries; every use hydrates the original tuple from durable SQL.
export class FacadeBearers {
  #entries: readonly { hash: Buffer; grant: Grant }[] = [];
  #executionKey?: Buffer;
  readonly #executionIssuers = new WeakMap<Grant, RunControlGrant>();
  constructor(entries: readonly ConfiguredBearer[]) {
    this.replace(entries);
  }
  replace(entries: readonly ConfiguredBearer[]): void {
    if (entries.length > 128) {
      throw new KernelError("invalid");
    }
    const next: { hash: Buffer; grant: Grant }[] = [];
    for (const entry of entries) {
      const token = entry.token,
        consumerId = entry.consumerId,
        role = entry.role;
      if (!/^[A-Za-z0-9._~-]{16,1024}$/.test(token)) {
        throw new KernelError("invalid");
      }
      identifier(consumerId);
      const hash = tokenHash(token);
      if (next.some((row) => timingSafeEqual(row.hash, hash))) {
        throw new KernelError("invalid");
      }
      let grant: Grant;
      if (role === "execution") {
        grant = Object.freeze({ role, consumerId, saved: savedCopy(entry.saved) });
      } else if (role === "consumer-control") {
        const supplied = entry.profileIds;
        if (!Array.isArray(supplied)) {
          throw new KernelError("invalid");
        }
        const length = supplied.length;
        if (length < 1 || length > 128) {
          throw new KernelError("invalid");
        }
        const suppliedValues: readonly unknown[] = supplied;
        const copiedProfileIds = Array.from({ length }, (_, i) => suppliedValues[i]);
        const limits = parse(c.limits, { ...entry.limits }),
          maxRunMs = entry.maxRunMs;
        if (
          new Set(copiedProfileIds).size !== length ||
          !Number.isSafeInteger(maxRunMs) ||
          maxRunMs < 1 ||
          maxRunMs > RUN_CONTROL_MAX_RUN_MS ||
          limits.concurrency > limits.requests
        ) {
          throw new KernelError("invalid");
        }
        const profileIds: string[] = [];
        for (const id of copiedProfileIds) {
          parse(c.reference, id);
          identifier(id, 64);
          profileIds.push(id);
        }
        grant = Object.freeze({
          role,
          consumerId,
          profileIds: Object.freeze(profileIds),
          limits: Object.freeze(limits),
          maxRunMs,
        });
      } else if (role === "run-control") {
        if (
          !entry.ownerRefs.length ||
          entry.ownerRefs.length > 100 ||
          !entry.profileIds.length ||
          entry.profileIds.length > 128 ||
          !Number.isSafeInteger(entry.maxRunMs) ||
          entry.maxRunMs < 1 ||
          entry.maxRunMs > RUN_CONTROL_MAX_RUN_MS ||
          entry.limits.concurrency > entry.limits.requests
        ) {
          throw new KernelError("invalid");
        }
        entry.ownerRefs.forEach((value) => parse(c.reference, value));
        entry.profileIds.forEach((value) => {
          parse(c.reference, value);
          identifier(value, 64);
        });
        grant = Object.freeze({
          role: "run-control",
          consumerId,
          ownerRefs: Object.freeze([...entry.ownerRefs]),
          profileIds: Object.freeze([...entry.profileIds]),
          limits: Object.freeze(parse(c.limits, entry.limits)),
          maxRunMs: entry.maxRunMs,
        });
      } else {
        const p = entry.preparation;
        const ownerScope: unknown = entry.ownerScope,
          suppliedOwners = entry.ownerRefs;
        if (
          !Object.is(role, "management") ||
          (ownerScope === "consumer"
            ? Object.hasOwn(entry, "ownerRefs")
            : ownerScope !== undefined ||
              Object.hasOwn(entry, "ownerScope") ||
              !Array.isArray(suppliedOwners) ||
              !suppliedOwners.length ||
              suppliedOwners.length > 100) ||
          p.accountRefs.length > 16 ||
          !Number.isSafeInteger(p.maxRunMs) ||
          p.maxRunMs < 1 ||
          p.maxRunMs > 3_600_000 ||
          p.limits.concurrency > p.limits.requests
        ) {
          throw new KernelError("invalid");
        }
        const ownerRefs = ownerScope === "consumer" ? undefined : Array.from(suppliedOwners!);
        ownerRefs?.forEach((value) => parse(c.reference, value));
        p.accountRefs.forEach(uuid);
        parse(c.reference, p.subjectRef);
        parse(c.reference, p.profileId);
        parse(c.revision, p.policyRevision);
        parse(c.revision, p.bindingRevision);
        const suppliedProfileIds = entry.profileIds;
        let profileIds: readonly string[] | undefined;
        if (suppliedProfileIds !== undefined) {
          if (!Array.isArray(suppliedProfileIds)) {
            throw new KernelError("invalid");
          }
          const length = suppliedProfileIds.length;
          if (length > 128) {
            throw new KernelError("invalid");
          }
          const suppliedValues: readonly unknown[] = suppliedProfileIds;
          const copiedProfileIds = Array.from({ length }, (_, i) => suppliedValues[i]);
          if (
            !copiedProfileIds.length ||
            new Set(copiedProfileIds).size !== copiedProfileIds.length
          ) {
            throw new KernelError("invalid");
          }
          const validatedProfileIds: string[] = [];
          for (const id of copiedProfileIds) {
            parse(c.reference, id);
            identifier(id, 64);
            validatedProfileIds.push(id);
          }
          profileIds = validatedProfileIds;
        }
        grant = Object.freeze({
          role: "management",
          consumerId,
          ...(profileIds === undefined ? {} : { profileIds: Object.freeze(profileIds) }),
          ...(ownerScope === "consumer"
            ? { ownerScope }
            : { ownerRefs: Object.freeze(ownerRefs!) }),
          preparation: Object.freeze({
            ...p,
            accountRefs: Object.freeze([...p.accountRefs]),
            limits: Object.freeze(parse(c.limits, p.limits)),
          }),
        });
      }
      next.push({ hash, grant });
    }
    this.#entries = next;
  }
  resolve(token: string): Grant | undefined {
    const hash = tokenHash(token);
    let found: Grant | undefined;
    for (const row of this.#entries) {
      if (timingSafeEqual(row.hash, hash)) {
        found = row.grant;
      }
    }
    return found;
  }
  current(grant: Grant): boolean {
    const issuer = this.#executionIssuers.get(grant);
    return this.#entries.some((row) => row.grant === (issuer ?? grant));
  }
  // Stable server-owned key, purpose separated from prepare intent digests.
  // The locator contains no native peer credential, private admission or body.
  configureExecutionKey(key: Uint8Array): void {
    if (key.byteLength !== 32) {
      throw new KernelError("invalid");
    }
    const derived = createHmac("sha256", key)
      .update("account-gateway/execution-locator/v1")
      .digest();
    if (this.#executionKey && !timingSafeEqual(this.#executionKey, derived)) {
      throw new KernelError("conflict");
    }
    this.#executionKey = derived;
  }
  #issuerFingerprint(row: { hash: Buffer; grant: Grant }): string {
    return createHash("sha256")
      .update(row.hash)
      .update(JSON.stringify(row.grant))
      .digest("base64url");
  }
  #savedFingerprint(saved: SavedExecution): string {
    return createHash("sha256")
      .update(JSON.stringify([saved.generation, ...admissionTuple(saved.admission)]))
      .digest("base64url");
  }
  async resolveExecution(token: string, kernel: ExecutionRead): Promise<Grant | undefined> {
    const configured = this.resolve(token);
    if (configured) {
      return configured;
    }
    if (!this.#executionKey || token.length > 1024) {
      return;
    }
    const parts = /^agx1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!parts) {
      return;
    }
    const expected = createHmac("sha256", this.#executionKey).update(parts[1]).digest();
    const signature = Buffer.from(parts[2], "base64url");
    if (
      signature.length !== expected.length ||
      signature.toString("base64url") !== parts[2] ||
      !timingSafeEqual(signature, expected)
    ) {
      return;
    }
    try {
      const raw = Buffer.from(parts[1], "base64url");
      if (raw.toString("base64url") !== parts[1]) {
        return;
      }
      const value: unknown = JSON.parse(raw.toString("utf8"));
      if (!Array.isArray(value) || value.length !== 5 || value.some((v) => typeof v !== "string")) {
        return;
      }
      const [issuer, consumerId, executionRef, savedFingerprint, expiresAt] = value as string[];
      identifier(consumerId);
      uuid(executionRef);
      if (!/^[A-Za-z0-9_-]{43}$/.test(issuer) || !/^[A-Za-z0-9_-]{43}$/.test(savedFingerprint)) {
        return;
      }
      const row = this.#entries.find(
        (entry) =>
          (entry.grant.role === "run-control" || entry.grant.role === "consumer-control") &&
          entry.grant.consumerId === consumerId &&
          this.#issuerFingerprint(entry) === issuer,
      );
      if (!row || (row.grant.role !== "run-control" && row.grant.role !== "consumer-control")) {
        return;
      }
      const saved = savedCopy(await kernel.savedExecution({ consumerId }, executionRef));
      if (
        saved.admission.expiresAt !== expiresAt ||
        this.#savedFingerprint(saved) !== savedFingerprint ||
        !this.current(row.grant)
      ) {
        return;
      }
      const grant = Object.freeze({ role: "execution" as const, consumerId, saved });
      this.#executionIssuers.set(grant, row.grant);
      return grant;
    } catch (error) {
      if (error instanceof KernelError && error.code === "unavailable") {
        throw error;
      }
      return;
    }
  }
  // Protected owner lookup uses current management policy, never a raw bearer
  // or a cached consumer-to-owner association. Replacement revokes immediately.
  authorizesOwner(context: TrustedContext, ownerRef: string, profileId: string): boolean {
    return this.#entries.some(
      ({ grant }) =>
        grant.consumerId === context.consumerId &&
        (grant.role === "consumer-control"
          ? grant.profileIds.includes(profileId)
          : grant.role === "management" &&
            permitsOwner(grant, ownerRef) &&
            permitsOAuthProfile(grant, profileId)),
    );
  }
  authorizesAccountLimits(context: TrustedContext, ownerRef: string, profileId: string): boolean {
    return this.#entries.some(
      ({ grant }) =>
        grant.consumerId === context.consumerId &&
        (grant.role === "consumer-control"
          ? grant.profileIds.includes(profileId)
          : grant.role === "management" &&
            permitsOwner(grant, ownerRef) &&
            permitsProfile(grant, profileId)),
    );
  }
  // Deterministic issuance after SQL read binds the original immutable tuple.
  // Config replacement revokes issued locators without an execution registry.
  upsertExecution(
    control: RunControlGrant,
    input: SavedExecution,
    original?: SavedExecution,
  ): string {
    if (
      (!Object.is(control.role, "run-control") && !Object.is(control.role, "consumer-control")) ||
      !this.current(control)
    ) {
      throw new KernelError("denied");
    }
    const saved = savedCopy(input);
    // Only the route's persisted original lookup, followed by prepare's exact
    // intent check, can authorize fenced readback. POST still checks dispatch.
    const fencedOriginal =
      saved.state === "fenced" && original !== undefined && sameSaved(original, saved);
    if (
      ((!saved.dispatchAllowed || saved.state !== "open") && !fencedOriginal) ||
      Date.parse(saved.admission.expiresAt) <= Date.now()
    ) {
      throw new KernelError("denied");
    }
    if (!this.#executionKey) {
      throw new KernelError("unavailable");
    }
    const row = this.#entries.find((entry) => entry.grant === control);
    if (!row) {
      throw new KernelError("denied");
    }
    const payload = Buffer.from(
      JSON.stringify([
        this.#issuerFingerprint(row),
        control.consumerId,
        saved.admission.executionRef,
        this.#savedFingerprint(saved),
        saved.admission.expiresAt,
      ]),
    ).toString("base64url");
    const signature = createHmac("sha256", this.#executionKey).update(payload).digest("base64url");
    const token = "agx1." + payload + "." + signature;
    if (token.length > 1024) {
      throw new KernelError("invalid");
    }
    return token;
  }
}
function admissionTuple(a: PrivateAdmission): readonly unknown[] {
  return [
    a.executionRef,
    a.issuerEpoch,
    a.invocationRef,
    a.attemptRef,
    a.accountRef,
    a.authorizationEpoch,
    a.subjectRef,
    a.policyRevision,
    a.bindingRevision,
    a.profileId,
    a.expiresAt,
    a.limits.requests,
    a.limits.concurrency,
    a.limits.requestBytes,
    a.limits.outputBytes,
    a.limits.tokens,
  ];
}
export function sameSaved(a: SavedExecution, b: SavedExecution): boolean {
  return (
    a.generation === b.generation &&
    JSON.stringify(admissionTuple(a.admission)) === JSON.stringify(admissionTuple(b.admission))
  );
}
