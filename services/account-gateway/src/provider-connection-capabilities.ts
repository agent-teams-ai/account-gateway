import * as c from "@agent-teams/account-gateway/contracts";
/** Backend catalog facts; the facade intersects deployment and bearer policy. */
export interface ProviderConnectionSource {
  getProviderConnectionCapabilities(): Promise<c.ProviderConnectionCapabilitiesV2>;
}
export function projectProviderConnections(
  snapshot: c.ProviderConnectionCapabilitiesV2,
  profiles: readonly Pick<c.Profile, "profileId" | "protocol" | "modelIds">[],
): c.ProviderConnectionCapabilitiesV2 {
  const accepted = c.providerConnectionCapabilitiesV2.parse(snapshot);
  return c.providerConnectionCapabilitiesV2.parse({
    contract: c.PROVIDER_CONNECTIONS_V2_CONTRACT,
    capabilities: profiles.flatMap((profile) => {
      const found = accepted.capabilities.find(
        (candidate) =>
          candidate.profileId === profile.profileId && candidate.protocol === profile.protocol,
      );
      if (!found) {
        return [];
      }
      const models = profile.modelIds.map((id) =>
        found.models.find((model) => model.modelId === id),
      );
      if (!models.length || models.some((model) => model === undefined)) {
        return [];
      }
      return [{ ...found, models }];
    }),
  });
}

/** Temporary v1 compatibility projection of the very same deployed snapshot. */
export function projectProviderConnectionsV1(
  snapshot: c.ProviderConnectionCapabilitiesV2,
): c.ProviderConnectionCapabilities {
  return c.providerConnectionCapabilities.parse({
    contract: c.PROVIDER_CONNECTIONS_CONTRACT,
    capabilities: snapshot.capabilities.flatMap((entry) => {
      const provider = c.providerIdentity.safeParse(entry.provider.id);
      if (!provider.success) {
        return [];
      }
      const methods = entry.methods.filter(
        (method) => method.create && method.kind !== "credential_import",
      );
      if (!methods.length) {
        return [];
      }
      const browser = methods.find((method) => method.kind === "browser");
      const reconnect = entry.methods.some(
        (method) => method.kind === "api_key" && method.reconnect,
      )
        ? "replace_api_key"
        : entry.methods.some(
              (method) => ["browser", "device_code"].includes(method.kind) && method.reconnect,
            )
          ? "oauth_reauthorize"
          : "none";
      return [
        {
          contract: c.PROVIDER_CONNECTIONS_CONTRACT,
          profileId: entry.profileId,
          provider: { identity: provider.data, label: entry.provider.label },
          plan: { identity: entry.product.id, label: entry.product.label },
          region: { identity: entry.region.id, label: entry.region.label },
          protocol: entry.protocol,
          modelIds: entry.models.map((model) => model.modelId),
          models: entry.models,
          authMethods: methods.map((method) =>
            method.kind === "api_key"
              ? "api_key"
              : method.kind === "browser"
                ? "oauth_authorization_code"
                : "oauth_device_code",
          ),
          completionInputKind: browser?.completionInputKind ?? "none",
          oauthCallbackMode: browser?.callbackMode ?? null,
          reconnect,
          limitsContract: entry.limitsContract,
          availability: entry.availability,
        },
      ];
    }),
  });
}
