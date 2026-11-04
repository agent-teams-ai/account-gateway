import type { NativeReadback, PhysicalCandidate } from "./management.ts";
import { physicalCandidate } from "./management.ts";
import type { OAuthProfileDefinition } from "./oauth-profiles.ts";

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
export const candidatesPath = "/private/native/v1/candidates";
export function oauthMethodDenied(method: unknown): boolean {
  return method !== undefined && method !== "device_code" && method !== "browser";
}
export function object(
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
export function decode(bytes: Buffer, maximumDepth = 4): unknown {
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
export function readback(bytes: Buffer): NativeReadback {
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
export function wireDescriptor(d: PhysicalCandidate): object {
  return {
    account_id: d.nativeId,
    generation: d.generation,
    created_at: d.createdAt,
    profile: d.profile,
    base_url: d.baseURL,
    model: d.model,
  };
}
export function oauthPhysical(
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
export function oauthEndpoint(
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
export function oauthPhysicalOrAPI(value: unknown): PhysicalCandidate {
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
export function samePhysical(a: PhysicalCandidate, b: PhysicalCandidate): boolean {
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
