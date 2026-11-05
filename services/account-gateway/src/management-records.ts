import { KernelError, identifier } from "./domain.ts";
import { exactCandidate, physicalCandidate } from "./candidate-identity.ts";
import { oauthProfileDefinition } from "./oauth-profiles.ts";
import type { CandidateJournal, CandidateMapping, ManagedProfile } from "./candidate-identity.ts";

// Persisted row projections are fail-closed and own no SQL or network access.
export interface JournalRow {
  consumer: string;
  operation_id: string;
  account_ref: string;
  owner_ref: string;
  purpose: "create" | "reconnect";
  generation: string;
  worker: string;
  profile: string;
  base_url: string;
  model: string;
  qualification_ref: string;
}
export function journalRow(r: JournalRow): CandidateJournal {
  return Object.freeze({
    consumerId: r.consumer,
    operationId: r.operation_id,
    accountRef: r.account_ref,
    ownerRef: r.owner_ref,
    purpose: r.purpose,
    generation: r.generation,
    worker: r.worker,
    profile: Object.freeze({
      profile: r.profile,
      baseURL: r.base_url,
      model: r.model,
      qualificationRef: r.qualification_ref,
    }),
  });
}
export const journalValues = (j: CandidateJournal): readonly unknown[] => [
  j.consumerId,
  j.operationId,
  j.accountRef,
  j.ownerRef,
  j.purpose,
  j.generation,
  j.worker,
  j.profile.profile,
  j.profile.baseURL,
  j.profile.model,
  j.profile.qualificationRef,
];
export function sameJournal(a: CandidateJournal, b: CandidateJournal): boolean {
  return JSON.stringify(journalValues(a)) === JSON.stringify(journalValues(b));
}
export type MappingRow = JournalRow & {
  native_physical_identity: string;
  native_id: string;
  native_created_at: string;
};
// SQL004's non-null mapping columns move together through this LEFT JOIN.
// An absent mapping is SQL NULL, not a Partial row with undefined fields.
export type JoinedMapping =
  | Pick<MappingRow, "native_physical_identity" | "native_id" | "native_created_at">
  | { native_physical_identity: null; native_id: null; native_created_at: null };
export function mappingRow(r: MappingRow): CandidateMapping {
  const j = journalRow(r);
  const descriptor = physicalCandidate({
    generation: j.generation,
    nativePhysicalIdentity: r.native_physical_identity,
    nativeId: Number(r.native_id),
    createdAt: r.native_created_at,
    profile: j.profile.profile,
    baseURL: j.profile.baseURL,
    model: j.profile.model,
  });
  if (!exactCandidate(j, descriptor)) {
    throw new KernelError("conflict");
  }
  return Object.freeze({ ...j, descriptor });
}
export function refreshProfile(source: ManagedProfile): ManagedProfile {
  const p = Object.freeze({
    profile: source.profile,
    baseURL: source.baseURL,
    model: source.model,
    qualificationRef: source.qualificationRef,
  });
  const definition = oauthProfileDefinition(p.profile);
  if (!definition || p.baseURL !== definition.baseURL || p.model !== definition.model) {
    throw new KernelError("invalid");
  }
  identifier(p.qualificationRef);
  return p;
}
