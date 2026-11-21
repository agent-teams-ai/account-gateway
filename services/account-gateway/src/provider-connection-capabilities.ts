import * as c from "@agent-teams/account-gateway/contracts";
import type { NativeConnectionProfile } from "./provider-connections.ts";
import type { LegacyConnectionKind } from "./connection-domain.ts";

/** Compatibility is explicit native alias authority, never the first matching form. */
export function compatibleLegacyConnection(
  profile: NativeConnectionProfile,
  kind: LegacyConnectionKind,
) {
  const alias = profile.legacyAliases.find((entry) => entry.kind === kind);
  const method =
    alias &&
    profile.capability.methods.find(
      (entry) =>
        entry.methodId === alias.connection.methodId &&
        entry.revision === alias.connection.methodRevision &&
        entry.configurationGeneration === alias.connection.configurationGeneration,
    );
  if (
    !alias ||
    !method ||
    !c.supportsConnectionMethod(method) ||
    method.availability !== "enabled" ||
    method.allowedCredentialPolicies.length !== 1 ||
    method.allowedCredentialPolicies[0] !==
      (kind === "api_key" ? "provider_key" : "subscription_session")
  ) {
    return;
  }
  const interaction = method.interaction;
  if (
    kind === "browser" &&
    (interaction.kind !== "browser" ||
      interaction.preflightFields?.some((f) => f.required) === true)
  ) {
    return;
  }
  if (
    kind === "device_code" &&
    (interaction.kind !== "device" || interaction.preflightFields?.some((f) => f.required) === true)
  ) {
    return;
  }
  if (
    (kind === "api_key" || kind.startsWith("credential_import:")) &&
    (interaction.kind !== "credential_form" ||
      alias.inputFieldId === undefined ||
      alias.inputFieldId === "" ||
      !interaction.inputFields.some((field) => field.fieldId === alias.inputFieldId) ||
      interaction.inputFields.some(
        (field) => field.fieldId !== alias.inputFieldId && field.required,
      ))
  ) {
    return;
  }
  return { ...alias, method };
}
export function projectNativeConnectionsV2(
  profiles: readonly NativeConnectionProfile[],
): c.ProviderConnectionCapabilitiesV2 {
  return {
    contract: c.PROVIDER_CONNECTIONS_V2_CONTRACT,
    capabilities: profiles.flatMap((profile) => {
      const methods = profile.legacyAliases.flatMap<
        c.ProviderConnectionCapabilityV2["methods"][number]
      >((declared) => {
        const alias = compatibleLegacyConnection(profile, declared.kind);
        if (!alias) {
          return [];
        }
        const common = { create: alias.method.create, reconnect: alias.method.reconnect };
        if (alias.kind === "api_key") {
          return [{ ...common, kind: "api_key" as const }];
        }
        if (alias.kind === "device_code") {
          return [{ ...common, kind: "device_code" as const }];
        }
        if (alias.kind === "browser" && alias.method.interaction.kind === "browser") {
          return [
            {
              ...common,
              kind: "browser" as const,
              completionInputKind: alias.method.interaction.completionInputKind,
              callbackMode:
                alias.method.interaction.callbackMode === "automatic"
                  ? ("automatic" as const)
                  : ("manual_callback_url" as const),
            },
          ];
        }
        return [
          {
            ...common,
            kind: "credential_import" as const,
            method:
              alias.kind === "credential_import:refresh_token"
                ? ("refresh_token" as const)
                : ("oauth_auth_json" as const),
            maxBytes: 65_536 as const,
          },
        ];
      });
      if (!methods.length) {
        return [];
      }
      const entry = profile.capability;
      const parsed = c.providerConnectionCapabilitiesV2.safeParse({
        contract: c.PROVIDER_CONNECTIONS_V2_CONTRACT,
        capabilities: [
          {
            profileId: entry.profileId,
            provider: entry.provider,
            product: entry.product,
            region: entry.region,
            protocol: entry.protocol,
            models: entry.models,
            methods,
            accountInfo: entry.accountInfo,
            limitsContract:
              entry.limitsContract === "account-limits/v1" ||
              entry.limitsContract === "account-limits/v2"
                ? entry.limitsContract
                : "none",
            availability: entry.availability,
          },
        ],
      });
      return parsed.success ? parsed.data.capabilities : [];
    }),
  };
}
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
      // V1 has one reconnect mode for every exposed method. A reconnect-only
      // method or asymmetric support cannot grant that permission to another.
      const reconnect = !methods.every((method) => method.reconnect)
        ? "none"
        : methods.every((method) => method.kind === "api_key")
          ? "replace_api_key"
          : methods.every((method) => method.kind === "browser" || method.kind === "device_code")
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
