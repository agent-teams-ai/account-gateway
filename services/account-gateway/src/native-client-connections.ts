import * as c from "@agent-teams/account-gateway/contracts";
import { secretSubmission } from "@agent-teams/account-gateway/http";
import { identifier, uuid } from "./domain.ts";
import type { RetainedCustodyProof } from "./domain.ts";
import {
  capturePublication,
  sameConnection,
  samePublication,
  LEGACY_CONNECTION_KINDS,
} from "./connection-domain.ts";
import type { ConnectionPublication, LegacyConnectionKind } from "./connection-domain.ts";
import type { NativeConnectionCapabilitiesSnapshot } from "./provider-connections.ts";
import { physicalCandidate, sameCandidate } from "./candidate-identity.ts";
import type { CandidateMapping, PhysicalCandidate } from "./candidate-identity.ts";
import type {
  NativeConnectionAdapter,
  OAuthScope,
  OAuthBeginReadback,
  OAuthReadback,
  OAuthCallback,
  OAuthDescriptor,
  OAuthRefreshReadback,
  OAuthCleanupAuthority,
  OAuthCleanupAction,
  OAuthCleanupReadback,
} from "./management.ts";
import { NativeControlHTTP, type NativeManagementOptions } from "./native-client-transport.ts";
import { NativeFailure, decode, object, wireDescriptor } from "./native-client-wire.ts";

export const NATIVE_CONNECTION_CAPABILITIES = "native-account-capabilities/v2";
const prefix = "/private/native/v2/connections/";
const legacyKinds: readonly string[] = LEGACY_CONNECTION_KINDS;

export function nativeConnectionPublication(value: unknown): ConnectionPublication {
  const publication = object(value, ["connection", "credential", "dispatchFamily", "authFamily"]);
  return capturePublication({
    connection: c.connectionBinding.parse(publication.connection),
    credential: c.credentialAttestation.parse(publication.credential),
    dispatchFamily: publication.dispatchFamily as string,
    authFamily: publication.authFamily as string,
  });
}
export function nativeConnectionPhysical(value: unknown): PhysicalCandidate {
  const d = object(value, [
    "account_id",
    "generation",
    "created_at",
    "profile",
    "base_url",
    "model",
    "publication",
  ]);
  return physicalCandidate({
    nativeId: d.account_id as number,
    generation: d.generation as string,
    nativePhysicalIdentity: d.generation as string,
    createdAt: d.created_at as string,
    profile: d.profile as string,
    baseURL: d.base_url as string,
    model: d.model as string,
    publication: nativeConnectionPublication(d.publication),
  });
}

export class NativeConnectionCapabilitiesClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({
      ...options,
      deadlineMs: Math.min(options.deadlineMs ?? 2000, 2000),
      bodyBytes: 2_097_152,
      distinguishNotListening: true,
    });
  }
  async read(
    signal?: AbortSignal,
    deadlineMs = 2000,
  ): Promise<NativeConnectionCapabilitiesSnapshot> {
    try {
      const wire = object(
        decode(
          await this.call(
            "GET",
            "/private/native/v2/account-capabilities",
            undefined,
            deadlineMs,
            signal,
          ),
          12,
        ),
        ["contract", "profiles", "enrollment"],
      );
      if (
        wire.contract !== NATIVE_CONNECTION_CAPABILITIES ||
        !Array.isArray(wire.profiles) ||
        wire.profiles.length > 128
      ) {
        throw new NativeFailure("invalid_readback");
      }
      const profiles = wire.profiles.map((value) => {
        const row = object(value, [
          "profileId",
          "provider",
          "product",
          "region",
          "protocol",
          "models",
          "modelPolicy",
          "methods",
          "accountInfo",
          "limitsContract",
          "availability",
          "mount",
          "legacyAliases",
        ]);
        const { mount: mountValue, legacyAliases: aliasesValue, ...safe } = row;
        const capability = c.connectionProfileV3.parse(safe);
        const mount = object(mountValue, ["baseURL", "model", "qualificationRef"]);
        identifier(mount.qualificationRef);
        if (
          !capability.models.some((model) => model.modelId === mount.model) ||
          !Array.isArray(aliasesValue) ||
          aliasesValue.length > 5
        ) {
          throw new NativeFailure("invalid_readback");
        }
        const legacyAliases = aliasesValue.map((entry) => {
          const alias = object(entry, ["kind", "connection"], ["inputFieldId"]);
          const connection = c.connectionBinding.parse(alias.connection);
          const sensitive =
            alias.kind === "api_key" || String(alias.kind).startsWith("credential_import:");
          if (sensitive !== (alias.inputFieldId !== undefined)) {
            throw new NativeFailure("invalid_readback");
          }
          if (alias.inputFieldId !== undefined) {
            identifier(alias.inputFieldId);
          }
          if (
            !legacyKinds.includes(alias.kind as string) ||
            connection.profileId !== capability.profileId ||
            !capability.methods.some(
              (method) =>
                method.methodId === connection.methodId &&
                method.revision === connection.methodRevision &&
                method.configurationGeneration === connection.configurationGeneration,
            )
          ) {
            throw new NativeFailure("invalid_readback");
          }
          return Object.freeze({
            kind: alias.kind as LegacyConnectionKind,
            connection,
            ...(alias.inputFieldId === undefined ? {} : { inputFieldId: alias.inputFieldId }),
          });
        });
        if (new Set(legacyAliases.map((alias) => alias.kind)).size !== legacyAliases.length) {
          throw new NativeFailure("invalid_readback");
        }
        const managed = {
          profile: capability.profileId,
          baseURL: mount.baseURL as string,
          model: mount.model as string,
          qualificationRef: mount.qualificationRef,
          nativeConnection: true as const,
        };
        physicalCandidate({
          ...managed,
          generation: "00000000-0000-4000-8000-000000000001",
          nativePhysicalIdentity: "00000000-0000-4000-8000-000000000001",
          nativeId: 1,
          createdAt: "2000-01-01T00:00:00Z",
        });
        return Object.freeze({
          capability,
          mount: Object.freeze(managed),
          legacyAliases: Object.freeze(legacyAliases),
        });
      });
      if (new Set(profiles.map((p) => p.capability.profileId)).size !== profiles.length) {
        throw new NativeFailure("invalid_readback");
      }
      const enrollment = object(wire.enrollment, [
        "originRef",
        "engineIncarnation",
        "qualificationRef",
      ]);
      identifier(enrollment.originRef);
      uuid(enrollment.engineIncarnation);
      identifier(enrollment.qualificationRef);
      return Object.freeze({
        profiles: Object.freeze(profiles),
        enrollment: Object.freeze({
          originRef: enrollment.originRef,
          engineIncarnation: enrollment.engineIncarnation,
          qualificationRef: enrollment.qualificationRef,
        }),
      });
    } catch (error) {
      if (error instanceof NativeFailure) {
        throw error;
      }
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** One generic control adapter. Provider-specific exchange and signing stay native. */
export class NativeConnectionClient extends NativeControlHTTP implements NativeConnectionAdapter {
  private capture(input: OAuthScope): OAuthScope & { connection: c.ConnectionBinding } {
    const scope = {
      consumerId: input.consumerId,
      operationId: input.operationId,
      ownerRef: input.ownerRef,
      accountRef: input.accountRef,
      generation: input.generation,
      connection: c.connectionBinding.parse(input.connection),
    };
    this.scope(scope);
    identifier(scope.operationId);
    return Object.freeze(scope);
  }
  private wire(scope: OAuthScope & { connection: c.ConnectionBinding }) {
    return {
      operation: scope.operationId,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
      generation: scope.generation,
      connection: scope.connection,
    };
  }
  private ack(
    bytes: Buffer,
    scope: OAuthScope & { connection: c.ConnectionBinding },
    begin: boolean,
  ): OAuthBeginReadback {
    try {
      const r = object(
        decode(bytes, 8),
        ["operation", "account_ref", "state", "connection"],
        ["outcome", "credential", ...(begin ? ["authorize_url", "device_authorization"] : [])],
      );
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        !sameConnection(c.connectionBinding.parse(r.connection), scope.connection) ||
        !["prepared", "entered", "completed", "expired", "unknown"].includes(r.state as string)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (r.outcome !== undefined) {
        identifier(r.outcome);
      }
      if (r.credential !== undefined) {
        c.credentialAttestation.parse(r.credential);
      }
      let authorizationURL: string | undefined;
      let deviceAuthorization: OAuthBeginReadback["deviceAuthorization"];
      if (r.authorize_url !== undefined) {
        if (!begin || r.state !== "prepared" || r.device_authorization !== undefined) {
          throw new NativeFailure("invalid_readback");
        }
        const challenge = c.connectionChallenge.parse({
          kind: "browser",
          authorizationURL: r.authorize_url,
        });
        if (challenge.kind !== "browser") {
          throw new NativeFailure("invalid_readback");
        }
        authorizationURL = challenge.authorizationURL;
      }
      if (r.device_authorization !== undefined) {
        if (!begin || r.state !== "prepared") {
          throw new NativeFailure("invalid_readback");
        }
        const d = object(r.device_authorization, [
          "user_code",
          "verification_url",
          "expires_at",
          "interval_seconds",
        ]);
        const challenge = c.connectionChallenge.parse({
          kind: "device",
          userCode: d.user_code,
          verificationURL: d.verification_url,
          expiresAt: d.expires_at,
          intervalSeconds: d.interval_seconds,
        });
        if (challenge.kind !== "device") {
          throw new NativeFailure("invalid_readback");
        }
        const { kind: _kind, ...safe } = challenge;
        deviceAuthorization = safe;
      }
      return Object.freeze({
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        state: r.state as OAuthReadback["state"],
        ...(authorizationURL === undefined ? {} : { authorizationURL }),
        ...(deviceAuthorization === undefined ? {} : { deviceAuthorization }),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async beginConnection(
    input: OAuthScope,
    inputFields?: Readonly<Record<string, string>>,
  ): Promise<OAuthBeginReadback> {
    const scope = this.capture(input),
      fields = secretSubmission.connectionInputFields.parse(inputFields ?? {});
    return this.ack(
      await this.call("POST", prefix + "begin", { ...this.wire(scope), input_fields: fields }),
      scope,
      true,
    );
  }
  async begin(_input: OAuthScope): Promise<OAuthBeginReadback> {
    throw new NativeFailure("denied");
  }
  async read(input: OAuthScope): Promise<OAuthReadback> {
    const scope = this.capture(input);
    return this.ack(await this.call("POST", prefix + "read", this.wire(scope)), scope, false);
  }
  async complete(input: OAuthScope, callback: OAuthCallback): Promise<OAuthReadback> {
    const scope = this.capture(input);
    if (!("authorizationCode" in callback)) {
      throw new NativeFailure("denied");
    }
    const fields = secretSubmission.connectionInputFields.parse({
      completion: callback.authorizationCode,
    });
    return this.ack(
      await this.call("POST", prefix + "submit", { ...this.wire(scope), input_fields: fields }),
      scope,
      false,
    );
  }
  async poll(input: OAuthScope): Promise<OAuthReadback> {
    const scope = this.capture(input);
    return this.ack(await this.call("POST", prefix + "poll", this.wire(scope)), scope, false);
  }
  async describe(input: OAuthScope): Promise<OAuthDescriptor> {
    const scope = this.capture(input);
    try {
      const r = object(
        decode(await this.call("POST", prefix + "describe", this.wire(scope)), 10),
        ["operation", "account_ref", "state", "qualification", "connection"],
        ["native"],
      );
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        r.state !== "staged" ||
        !sameConnection(c.connectionBinding.parse(r.connection), scope.connection)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (r.qualification === "pending" && r.native === undefined) {
        return {
          operationId: scope.operationId,
          accountRef: scope.accountRef,
          state: "staged",
          qualification: "pending",
        };
      }
      const native = nativeConnectionPhysical(r.native);
      if (
        r.qualification !== "controlled-source-v1" ||
        native.generation !== scope.generation ||
        !sameConnection(native.publication?.connection, scope.connection)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      return {
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        state: "qualified",
        qualification: "controlled-source-v1",
        native,
      };
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async refresh(input: OAuthScope): Promise<OAuthRefreshReadback> {
    const scope = this.capture(input);
    const r = object(
      decode(await this.call("POST", prefix + "refresh", this.wire(scope)), 6),
      ["operation", "account_ref", "state", "connection"],
      ["refresh_ref"],
    );
    if (
      r.operation !== scope.operationId ||
      r.account_ref !== scope.accountRef ||
      !sameConnection(c.connectionBinding.parse(r.connection), scope.connection) ||
      !["idle", "prepared", "entered", "completed", "unknown"].includes(r.state as string)
    ) {
      throw new NativeFailure("invalid_readback");
    }
    if (r.refresh_ref !== undefined) {
      identifier(r.refresh_ref);
    }
    return {
      operationId: scope.operationId,
      accountRef: scope.accountRef,
      state: r.state as OAuthRefreshReadback["state"],
      ...(r.refresh_ref === undefined ? {} : { refreshRef: r.refresh_ref }),
    };
  }
  async cleanup(
    input: OAuthScope,
    authority: OAuthCleanupAuthority,
    action: OAuthCleanupAction,
  ): Promise<OAuthCleanupReadback> {
    const scope = this.capture(input);
    identifier(authority.cleanupRef);
    identifier(authority.cleanupToken);
    if (!["read", "erase"].includes(action)) {
      throw new NativeFailure("denied");
    }
    const r = object(
      decode(
        await this.call("POST", prefix + "cleanup", {
          ...this.wire(scope),
          cleanup_ref: authority.cleanupRef,
          cleanup_token: authority.cleanupToken,
          action,
        }),
        10,
      ),
      ["operation", "account_ref", "connection", "credentials_erased", "closure"],
      ["native"],
    );
    if (
      r.operation !== scope.operationId ||
      r.account_ref !== scope.accountRef ||
      !sameConnection(c.connectionBinding.parse(r.connection), scope.connection) ||
      typeof r.credentials_erased !== "boolean" ||
      !["pending", "closed", "unknown"].includes(r.closure as string) ||
      (r.closure === "closed" && !r.credentials_erased)
    ) {
      throw new NativeFailure("invalid_readback");
    }
    return {
      operationId: scope.operationId,
      accountRef: scope.accountRef,
      credentialsErased: r.credentials_erased,
      closure: r.closure as OAuthCleanupReadback["closure"],
      ...(r.native === undefined ? {} : { native: nativeConnectionPhysical(r.native) }),
    };
  }
  async verify(mapping: CandidateMapping): Promise<RetainedCustodyProof> {
    const scope = this.capture({ ...mapping, connection: mapping.connectionSnapshot?.connection });
    if (
      !mapping.descriptor.publication ||
      !sameConnection(mapping.descriptor.publication.connection, scope.connection)
    ) {
      throw new NativeFailure("denied");
    }
    const r = object(
      decode(
        await this.call("POST", prefix + "custody", {
          ...this.wire(scope),
          descriptor: {
            ...wireDescriptor(mapping.descriptor),
            publication: mapping.descriptor.publication,
          },
        }),
        10,
      ),
      ["contract", "generation", "native", "credential_kinds", "retention", "proof"],
    );
    const native = nativeConnectionPhysical(r.native);
    const retained = object(r.retention, ["state", "credential"]),
      proof = object(r.proof, ["authenticated"]);
    if (
      r.contract !== "native-retained-custody/v2" ||
      r.generation !== scope.generation ||
      !sameCandidate(native, mapping.descriptor) ||
      !samePublication(native.publication, mapping.descriptor.publication) ||
      !Array.isArray(r.credential_kinds) ||
      r.credential_kinds.length !== 1 ||
      r.credential_kinds[0] !== mapping.descriptor.publication.credential.credentialKind ||
      !["active", "inactive"].includes(retained.state as string) ||
      retained.credential !== "retained" ||
      proof.authenticated !== true
    ) {
      throw new NativeFailure("invalid_readback");
    }
    return {
      contract: "native-retained-custody/v2",
      generation: scope.generation,
      nativePhysicalIdentity: native.nativePhysicalIdentity,
      credentialKinds: [mapping.descriptor.publication.credential.credentialKind],
      publication: mapping.descriptor.publication,
    };
  }
}
