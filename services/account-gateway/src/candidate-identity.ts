import { KernelError, identifier, uuid } from "./domain.ts";

// Account-candidate shapes and validation are stable domain policy, independent
// of lifecycle orchestration, SQL and native HTTP.
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
export function exactCandidate(j: CandidateJournal, d: PhysicalCandidate): boolean {
  return (
    d.generation === j.generation &&
    d.nativePhysicalIdentity === j.generation &&
    d.profile === j.profile.profile &&
    d.baseURL === j.profile.baseURL &&
    d.model === j.profile.model
  );
}
export function sameCandidate(a: PhysicalCandidate, b: PhysicalCandidate): boolean {
  return (
    a.generation === b.generation &&
    a.nativePhysicalIdentity === b.nativePhysicalIdentity &&
    a.nativeId === b.nativeId &&
    a.createdAt === b.createdAt &&
    a.profile === b.profile &&
    a.baseURL === b.baseURL &&
    a.model === b.model
  );
}
// Keep RFC3339 text verbatim. No Date conversion, ID-only or latest-row recovery.
export function physicalCandidate(input: PhysicalCandidate): PhysicalCandidate {
  const d = {
    generation: input.generation,
    nativePhysicalIdentity: input.nativePhysicalIdentity,
    nativeId: input.nativeId,
    createdAt: input.createdAt,
    profile: input.profile,
    baseURL: input.baseURL,
    model: input.model,
  };
  uuid(d.generation);
  uuid(d.nativePhysicalIdentity);
  identifier(d.profile, 64);
  if (
    !Number.isSafeInteger(d.nativeId) ||
    d.nativeId < 1 ||
    typeof d.createdAt !== "string" ||
    d.createdAt.length > 64 ||
    !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      d.createdAt,
    ) ||
    typeof d.baseURL !== "string" ||
    d.baseURL.length > 2048 ||
    typeof d.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(d.model)
  ) {
    throw new KernelError("invalid");
  }
  const year = Number(d.createdAt.slice(0, 4)),
    month = Number(d.createdAt.slice(5, 7)),
    day = Number(d.createdAt.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || day > days[month - 1]) {
    throw new KernelError("invalid");
  }
  let url: URL;
  try {
    url = new URL(d.baseURL);
  } catch {
    throw new KernelError("invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new KernelError("invalid");
  }
  return Object.freeze(d);
}
