import * as c from "@agent-teams/account-gateway/contracts";
import { KernelError } from "./domain.ts";
import type { PhysicalCandidate } from "./management.ts";
import { sameCandidate } from "./management.ts";

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
  let result: c.AccountModels = { status: "unavailable" };
  try {
    const parsed = c.accountModels.safeParse(await source?.readAccountModels(input));
    if (parsed.success) result = parsed.data;
  } catch {
    // A failed observation cannot add model membership. Still enforce the final fence.
  }
  const after = await currentIdentity();
  if (!sameCandidate(before, after)) throw new KernelError("denied");
  if (result.status === "snapshot") {
    if (result.physicalGeneration !== after.generation) throw new KernelError("denied");
    const now = Date.now();
    if (Date.parse(result.fetchedAt) > now || Date.parse(result.expiresAt) <= now)
      return { status: "unavailable" };
  }
  return result;
}

/** Empty authoritative snapshots remain empty. Missing observations retain only the frozen anchor. */
export function accountModelAdmission(result: c.AccountModels, anchor: string) {
  return result.status === "snapshot"
    ? { modelIds: result.models.map((model) => model.modelId), models: result.models, enforceCapabilities: true }
    : { modelIds: result.status === "unavailable" ? [anchor] : [], models: undefined, enforceCapabilities: false };
}
