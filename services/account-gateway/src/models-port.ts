import * as c from "@agent-teams/account-gateway/contracts";
import { KernelError } from "./domain.ts";
import type { PhysicalCandidate } from "./management.ts";
import { sameCandidate } from "./management.ts";
import { providerConnectionDefinition } from "./provider-connections.ts";

export function configuredAccountModelSource(profileId: string) {
  const profile = providerConnectionDefinition(profileId);
  return profile && c.accountModelDiscoverySource({
    profileId, protocol: profile.protocol, authKind: profile.oauth ? "oauth" : "api_key",
  });
}

export interface AccountModelsSource {
  readAccountModels(input: c.AccountModelsRequest): Promise<c.AccountModels>;
}
/** The resolver owns logical authorization and physical custody; rerun after every source await. */
export async function readAccountModels(
  source: AccountModelsSource | undefined,
  input: c.AccountModelsRequest,
  currentIdentity: () => Promise<PhysicalCandidate>,
): Promise<c.AccountModels> {
  const before = await currentIdentity();
  let result: c.AccountModels = { status: "unknown" };
  try {
    const parsed = c.accountModels.safeParse(await source?.readAccountModels(input));
    if (parsed.success) result = parsed.data;
  } catch {
    // A failed observation cannot add model membership. Still enforce the final fence.
  }
  const after = await currentIdentity();
  if (!sameCandidate(before, after)) throw new KernelError("denied");
  if (result.status === "snapshot") {
    if (result.source !== configuredAccountModelSource(input.profileId) || result.physicalGeneration !== after.generation) throw new KernelError("denied");
    const now = Date.now();
    if (Date.parse(result.fetchedAt) > now || Date.parse(result.expiresAt) <= now)
      return { status: "unknown" };
  }
  return result;
}

/** Empty/unknown observations admit nothing; only explicit unavailability retains the frozen anchor. */
export function accountModelAdmission(result: c.AccountModels, anchor: string) {
  return result.status === "snapshot"
    ? { modelIds: result.models.map((model) => model.modelId), models: result.models, enforceCapabilities: true }
    : { modelIds: result.status === "unavailable" ? [anchor] : [], models: undefined, enforceCapabilities: false };
}
