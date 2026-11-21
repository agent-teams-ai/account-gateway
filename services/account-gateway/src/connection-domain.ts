import { identifier, revision, KernelError } from "./domain.ts";

// Consumer-owned authority facts. No provider, HTTP, SQL or schema-framework types.
export interface ConnectionBinding {
  readonly profileId: string;
  readonly methodId: string;
  readonly methodRevision: number;
  readonly configurationGeneration: string;
}
export const LEGACY_CONNECTION_KINDS = ["api_key", "browser", "device_code",
  "credential_import:refresh_token", "credential_import:oauth_auth_json"] as const;
export type LegacyConnectionKind = typeof LEGACY_CONNECTION_KINDS[number];
export function captureLegacyConnectionKind(value: unknown): LegacyConnectionKind {
  if (typeof value !== "string" || !LEGACY_CONNECTION_KINDS.includes(value as LegacyConnectionKind)) {
    throw new KernelError("invalid");
  }
  return value as LegacyConnectionKind;
}
export type CredentialPolicy = "provider_key" | "subscription_session" | "cloud_identity" | "delegated_identity";
export interface CredentialAttestation {
  readonly credentialKind: "api_key" | "oauth" | "native";
  readonly credentialPolicy: CredentialPolicy;
  readonly refreshPolicy: "native" | "none";
}
export interface ConnectionPublication {
  readonly connection: ConnectionBinding;
  readonly credential: CredentialAttestation;
  readonly dispatchFamily: string;
  readonly authFamily: string;
}
export interface ConnectionInputField {
  readonly fieldId: string;
  readonly kind: "text" | "secret" | "select" | "document";
  readonly label: string;
  readonly required: boolean;
  readonly maxBytes: number;
  readonly help?: string;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
}
export type ConnectionInteraction =
  | { readonly kind: "browser"; readonly preflightFields?: readonly ConnectionInputField[];
      readonly callbackMode: "automatic" | "manual"; readonly completionInputKind: "callback_url" | "authorization_code" }
  | { readonly kind: "device"; readonly preflightFields?: readonly ConnectionInputField[] }
  | { readonly kind: "credential_form"; readonly inputFields: readonly ConnectionInputField[] };
export interface ConnectionMethod {
  readonly methodId: string;
  readonly revision: number;
  readonly configurationGeneration: string;
  readonly label: string;
  readonly create: boolean;
  readonly reconnect: boolean;
  readonly allowedCredentialPolicies: readonly CredentialPolicy[];
  readonly requirements: readonly string[];
  readonly availability: "enabled" | "deployment_configuration_required";
  readonly reason?: string;
  readonly interaction: ConnectionInteraction;
}
export interface ConnectionSnapshot {
  readonly connection: ConnectionBinding;
  readonly method: ConnectionMethod;
  readonly credential?: CredentialAttestation;
}
const requirements = ["owner_scoped_custody/v1", "effect_fence/v1", "native_dispatch/v1"];
const policies: readonly CredentialPolicy[] = ["provider_key", "subscription_session", "cloud_identity", "delegated_identity"];
function plain(value: string, maximum: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length < 1 || value.length > maximum) {
    throw new KernelError("invalid");
  }
  return value;
}
function captureFields(input: readonly ConnectionInputField[] | undefined): readonly ConnectionInputField[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw new KernelError("invalid");
  const fields = input.map((field) => {
    identifier(field.fieldId);
    if (!["text", "secret", "select", "document"].includes(field.kind) || typeof field.required !== "boolean" ||
      !Number.isSafeInteger(field.maxBytes) || field.maxBytes < 1 || field.maxBytes > 65_536) throw new KernelError("invalid");
    const choices = field.kind === "select" ? field.choices?.map((choice: { readonly value: string; readonly label: string }) => Object.freeze({
      value: plain(choice.value, 256), label: plain(choice.label, 128),
    })) : undefined;
    if (field.kind === "select" && (!choices || !choices.length || choices.length > 64 ||
      new Set(choices.map((c: { readonly value: string }) => c.value)).size !== choices.length)) throw new KernelError("invalid");
    return Object.freeze({ fieldId: field.fieldId, kind: field.kind, label: plain(field.label, 128),
      required: field.required, maxBytes: field.maxBytes,
      ...(field.help === undefined ? {} : { help: plain(field.help, 512) }),
      ...(choices === undefined ? {} : { choices: Object.freeze(choices) }) });
  });
  if (new Set(fields.map((f) => f.fieldId)).size !== fields.length) throw new KernelError("invalid");
  return Object.freeze(fields);
}
export function captureConnectionSnapshot(input: ConnectionSnapshot): ConnectionSnapshot {
  try {
    const connection = captureConnectionBinding(input.connection);
    const m = input.method;
    if (m.methodId !== connection.methodId || m.revision !== connection.methodRevision ||
      m.configurationGeneration !== connection.configurationGeneration ||
      typeof m.create !== "boolean" || typeof m.reconnect !== "boolean" ||
      !["enabled", "deployment_configuration_required"].includes(m.availability) ||
      !m.allowedCredentialPolicies.length || m.allowedCredentialPolicies.length > 4 ||
      m.allowedCredentialPolicies.some((p) => !policies.includes(p)) ||
      new Set(m.allowedCredentialPolicies).size !== m.allowedCredentialPolicies.length ||
      m.requirements.length !== requirements.length || !requirements.every((r) => m.requirements.includes(r))) {
      throw new KernelError("invalid");
    }
    let interaction: ConnectionInteraction;
    if (m.interaction.kind === "credential_form") {
      const inputFields = captureFields(m.interaction.inputFields);
      if (!inputFields) throw new KernelError("invalid");
      interaction = Object.freeze({ kind: "credential_form", inputFields });
    } else if (m.interaction.kind === "browser" || m.interaction.kind === "device") {
      const preflightFields = captureFields(m.interaction.preflightFields);
      const optional = preflightFields === undefined ? {} : { preflightFields };
      if (m.interaction.kind === "browser") {
        if (!["automatic", "manual"].includes(m.interaction.callbackMode) ||
          !["callback_url", "authorization_code"].includes(m.interaction.completionInputKind)) throw new KernelError("invalid");
        interaction = Object.freeze({ kind: "browser", ...optional, callbackMode: m.interaction.callbackMode,
          completionInputKind: m.interaction.completionInputKind });
      } else interaction = Object.freeze({ kind: "device", ...optional });
    } else throw new KernelError("invalid");
    const method: ConnectionMethod = Object.freeze({ methodId: connection.methodId, revision: connection.methodRevision,
      configurationGeneration: connection.configurationGeneration, label: plain(m.label, 128), create: m.create,
      reconnect: m.reconnect, allowedCredentialPolicies: Object.freeze([...m.allowedCredentialPolicies]),
      requirements: Object.freeze([...m.requirements]), availability: m.availability, interaction,
      ...(m.reason === undefined ? {} : { reason: plain(m.reason, 128) }) });
    const credential = input.credential;
    if (credential && (!method.allowedCredentialPolicies.includes(credential.credentialPolicy) ||
      !["api_key", "oauth", "native"].includes(credential.credentialKind) ||
      !["native", "none"].includes(credential.refreshPolicy))) throw new KernelError("invalid");
    const snapshot = Object.freeze({ connection, method, ...(credential === undefined ? {} : { credential: Object.freeze({
      credentialKind: credential.credentialKind, credentialPolicy: credential.credentialPolicy,
      refreshPolicy: credential.refreshPolicy,
    }) }) });
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 65_536) throw new KernelError("invalid");
    return snapshot;
  } catch {
    throw new KernelError("invalid");
  }
}

export function acceptsConnectionInputs(method: ConnectionMethod, input: Readonly<Record<string, string>> | undefined): boolean {
  try {
    connectionInputCommitment(input);
    const fields = method.interaction.kind === "credential_form" ? method.interaction.inputFields : method.interaction.preflightFields ?? [];
    const values = input ?? {};
    return Object.keys(values).every((key) => fields.some((field) => field.fieldId === key)) && fields.every((field) => {
      const value = values[field.fieldId];
      return value === undefined ? !field.required : (!field.required || value.length > 0) &&
        Buffer.byteLength(value, "utf8") <= field.maxBytes && (field.kind !== "select" || field.choices?.some((c) => c.value === value));
    });
  } catch { return false; }
}
export function captureConnectionBinding(input: ConnectionBinding): ConnectionBinding {
  const binding = Object.freeze({
    profileId: input.profileId,
    methodId: input.methodId,
    methodRevision: input.methodRevision,
    configurationGeneration: input.configurationGeneration,
  });
  identifier(binding.profileId, 64);
  identifier(binding.methodId);
  identifier(binding.configurationGeneration);
  revision(binding.methodRevision);
  if (binding.methodRevision < 1) throw new KernelError("invalid");
  return binding;
}
export function sameConnection(a: ConnectionBinding | undefined, b: ConnectionBinding | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined &&
    a.profileId === b.profileId && a.methodId === b.methodId &&
    a.methodRevision === b.methodRevision && a.configurationGeneration === b.configurationGeneration;
}
export function samePublication(a: ConnectionPublication | undefined, b: ConnectionPublication | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined &&
    sameConnection(a.connection, b.connection) && a.dispatchFamily === b.dispatchFamily && a.authFamily === b.authFamily &&
    a.credential.credentialKind === b.credential.credentialKind &&
    a.credential.credentialPolicy === b.credential.credentialPolicy && a.credential.refreshPolicy === b.credential.refreshPolicy;
}
export function capturePublication(input: ConnectionPublication): ConnectionPublication {
  const connection = captureConnectionBinding(input.connection);
  const credential = Object.freeze({ credentialKind: input.credential.credentialKind,
    credentialPolicy: input.credential.credentialPolicy, refreshPolicy: input.credential.refreshPolicy });
  if (!['api_key', 'oauth', 'native'].includes(credential.credentialKind) ||
    !['provider_key', 'subscription_session', 'cloud_identity', 'delegated_identity'].includes(credential.credentialPolicy) ||
    !['native', 'none'].includes(credential.refreshPolicy)) throw new KernelError("invalid");
  identifier(input.dispatchFamily);
  identifier(input.authFamily);
  return Object.freeze({ connection, credential, dispatchFamily: input.dispatchFamily, authFamily: input.authFamily });
}

/** Canonical secret commitment input; values are never returned as a safe record. */
export function connectionInputCommitment(input: Readonly<Record<string, string>> | undefined): readonly (readonly [string, string])[] {
  if (input === undefined) return [];
  const keys = Object.keys(input).sort();
  if (keys.length > 16) throw new KernelError("invalid");
  for (const key of keys) {
    identifier(key);
    const value = input[key];
    if (typeof value !== "string" || !value.isWellFormed()) throw new KernelError("invalid");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 65_536) throw new KernelError("invalid");
  return keys.map((key) => [key, input[key]] as const);
}
