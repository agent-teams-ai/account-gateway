import * as c from "@agent-teams/account-gateway/contracts";
import { providerConnectionDefinition } from "./provider-connections.ts";
import type { ProviderConnectionDefinition } from "./provider-connections.ts";

export function providerConnectionCapability(
  definition: ProviderConnectionDefinition,
  modelIds?: readonly string[],
): c.ProviderConnectionCapability {
  const selected =
    modelIds &&
    definition.profileId !== "openai-responses-apikey-v1" &&
    definition.provider.identity !== "openrouter"
      ? definition.models.filter((model) => modelIds.includes(model.modelId))
      : (modelIds?.map((modelId) => ({
          modelId,
          reasoning: null,
          fast: null,
          tools: {
            allowed:
              definition.provider.identity === "openrouter"
                ? (["none"] as const)
                : (["function", "function_and_custom"] as const),
            default:
              definition.provider.identity === "openrouter"
                ? ("none" as const)
                : ("function" as const),
          },
        })) ?? definition.models);
  if (!selected.length || selected.length !== (modelIds?.length ?? definition.models.length)) {
    throw new Error("unqualified_model");
  }
  return c.providerConnectionCapability.parse({
    contract: c.PROVIDER_CONNECTIONS_CONTRACT,
    profileId: definition.profileId,
    provider: definition.provider,
    plan: definition.plan,
    region: definition.region,
    protocol: definition.protocol,
    modelIds: selected.map((model) => model.modelId),
    authMethods: definition.authMethods,
    completionInputKind: definition.completionInputKind,
    availability: definition.availability,
    oauthCallbackMode: definition.oauthCallbackMode,
    reconnect: definition.reconnect,
    limitsContract: definition.limitsContract,
    models: selected.map((model) => ({
      modelId: model.modelId,
      reasoning: model.reasoning,
      fast: model.fast,
      tools: model.tools,
    })),
  });
}
export function projectProviderConnections(
  profiles: readonly Pick<c.Profile, "profileId" | "protocol" | "modelIds">[],
): c.ProviderConnectionCapabilities {
  const capabilities = profiles.flatMap((profile) => {
    const entry = providerConnectionDefinition(profile.profileId);
    if (!entry || entry.protocol !== profile.protocol) {
      return [];
    }
    try {
      return [providerConnectionCapability(entry, profile.modelIds)];
    } catch {
      return [];
    }
  });
  return c.providerConnectionCapabilities.parse({
    contract: c.PROVIDER_CONNECTIONS_CONTRACT,
    capabilities,
  });
}
