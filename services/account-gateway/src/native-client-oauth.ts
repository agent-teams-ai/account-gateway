import {
  codexOAuthAuthorizationURL,
  claudeOAuthAuthorizationURL,
  grokOAuthAuthorizationURL,
  oauthDeviceAuthorization,
} from "@agent-teams/account-gateway/contracts";
import { secretSubmission } from "@agent-teams/account-gateway/http";
import { KernelError, identifier, uuid } from "./domain.ts";
import { codexOAuthProfile, oauthProfileDefinition, type OAuthProfileDefinition } from "./oauth-profiles.ts";
import type {
  OAuthScope,
  OAuthEnrollmentNative,
  OAuthReadback,
  OAuthBeginReadback,
  OAuthCallback,
  OAuthMethod,
  OAuthDescriptor,
  OAuthDescriptorBoundary,
  OAuthRefreshNative,
  OAuthRefreshReadback,
  OAuthLifecycleNative,
  OAuthCleanupAuthority,
  OAuthCleanupAction,
  OAuthCleanupReadback,
} from "./management.ts";
import { NativeControlHTTP, type NativeManagementOptions } from "./native-client-transport.ts";
import {
  NativeFailure,
  object,
  decode,
  oauthPhysical,
  oauthEndpoint,
  oauthMethodDenied,
} from "./native-client-wire.ts";

export class NativeOAuthEnrollmentClient
  extends NativeControlHTTP
  implements OAuthEnrollmentNative, OAuthDescriptorBoundary, OAuthRefreshNative
{
  readonly #owner: string;
  readonly #definition: OAuthProfileDefinition;
  readonly #grokBrowserPolicy?: { readonly clientId: string; readonly redirectURI: string };
  constructor(
    options: NativeManagementOptions & {
      readonly ownerRef: string;
      readonly profileId?: string;
      readonly grokBrowserPolicy?: { readonly clientId: string; readonly redirectURI: string };
    },
  ) {
    super(options);
    identifier(options.ownerRef);
    this.#owner = options.ownerRef;
    const definition = oauthProfileDefinition(options.profileId ?? codexOAuthProfile.profile);
    if (!definition) {
      throw new KernelError("invalid");
    }
    this.#definition = definition;
    if (definition.family === "grok") {
      if (!options.grokBrowserPolicy) {
        throw new KernelError("invalid");
      }
      this.#grokBrowserPolicy = Object.freeze({ ...options.grokBrowserPolicy });
    }
  }
  private capture(input: OAuthScope): OAuthScope {
    const scope = Object.freeze({
      consumerId: input.consumerId,
      operationId: input.operationId,
      ownerRef: input.ownerRef,
      accountRef: input.accountRef,
      generation: input.generation,
    });
    this.scope(scope);
    identifier(scope.operationId);
    if (scope.ownerRef !== this.#owner) {
      throw new NativeFailure("denied");
    }
    return scope;
  }
  private wire(scope: OAuthScope): object {
    // Exact native input; no client, redirect, endpoint, profile, display name,
    // PKCE verifier or credential is accepted from the consumer. Completion
    // adds only the separately validated callback state/code to this tuple.
    return {
      operation: scope.operationId,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
      generation: scope.generation,
    };
  }
  private ack(bytes: Buffer, scope: OAuthScope, begin: boolean): OAuthBeginReadback {
    try {
      const r = object(
        decode(bytes),
        ["operation", "account_ref", "state"],
        begin
          ? ["outcome", "authorize_url", "device_authorization", "method"]
          : ["outcome", "method"],
      );
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        !["prepared", "entered", "completed", "expired", "unknown"].includes(r.state as string)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (
        (Object.hasOwn(r, "method") && r.method !== "device_code" && r.method !== "browser") ||
        (!this.#definition.deviceCode && r.method === "device_code")
      ) {
        throw new NativeFailure("invalid_readback");
      }
      // Native outcome is not a safe DTO or a no-effect receipt. Validate its
      // bounded primitive shape then discard; never reflect vendor diagnostics.
      if (
        Object.hasOwn(r, "outcome") &&
        (typeof r.outcome !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(r.outcome))
      ) {
        throw new NativeFailure("invalid_readback");
      }
      let authorizationURL: string | undefined;
      if (Object.hasOwn(r, "authorize_url")) {
        if (!begin || r.state !== "prepared" || r.method === "device_code") {
          throw new NativeFailure("invalid_readback");
        }
        const schema =
          this.#definition.family === "claude"
            ? claudeOAuthAuthorizationURL
            : this.#definition.family === "grok"
              ? grokOAuthAuthorizationURL
              : codexOAuthAuthorizationURL;
        const parsed = schema.safeParse(r.authorize_url);
        if (!parsed.success) {
          throw new NativeFailure("invalid_readback");
        }
        if (this.#grokBrowserPolicy) {
          const url = new URL(parsed.data);
          if (
            url.searchParams.get("client_id") !== this.#grokBrowserPolicy.clientId ||
            url.searchParams.get("redirect_uri") !== this.#grokBrowserPolicy.redirectURI
          ) {
            throw new NativeFailure("invalid_readback");
          }
        }
        authorizationURL = parsed.data;
      }
      let deviceAuthorization: OAuthBeginReadback["deviceAuthorization"];
      if (Object.hasOwn(r, "device_authorization")) {
        if (
          !this.#definition.deviceCode ||
          !begin ||
          r.state !== "prepared" ||
          r.method !== "device_code" ||
          authorizationURL !== undefined
        ) {
          throw new NativeFailure("invalid_readback");
        }
        const d = object(r.device_authorization, [
          "user_code",
          "verification_url",
          "expires_at",
          "interval_seconds",
        ]);
        const parsed = oauthDeviceAuthorization.safeParse({
          userCode: d.user_code,
          verificationURL: d.verification_url,
          expiresAt: d.expires_at,
          intervalSeconds: d.interval_seconds,
        });
        if (!parsed.success) {
          throw new NativeFailure("invalid_readback");
        }
        deviceAuthorization = Object.freeze(parsed.data);
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
  async begin(input: OAuthScope, method?: OAuthMethod): Promise<OAuthBeginReadback> {
    const scope = this.capture(input);
    if (oauthMethodDenied(method) || (method === "device_code" && !this.#definition.deviceCode)) {
      throw new NativeFailure("denied");
    }
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "begin"), {
        ...this.wire(scope),
        ...(method === undefined ? {} : { method }),
      }),
      scope,
      true,
    );
    if (
      method === "device_code"
        ? result.authorizationURL !== undefined
        : result.deviceAuthorization !== undefined
    ) {
      throw new NativeFailure("invalid_readback");
    }
    return result;
  }
  async poll(input: OAuthScope): Promise<OAuthReadback> {
    if (!this.#definition.deviceCode) {
      throw new NativeFailure("denied");
    }
    const scope = this.capture(input);
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "poll"), this.wire(scope)),
      scope,
      false,
    );
    return Object.freeze({
      operationId: result.operationId,
      accountRef: result.accountRef,
      state: result.state,
    });
  }
  async complete(input: OAuthScope, callback: OAuthCallback): Promise<OAuthReadback> {
    const scope = this.capture(input);
    let completion: OAuthCallback;
    if ("authorizationCode" in callback) {
      const authorizationCode = callback.authorizationCode;
      if (
        this.#definition.family !== "grok" ||
        !secretSubmission.grokOAuthAuthorizationCode.safeParse(authorizationCode).success
      ) {
        throw new NativeFailure("bounded");
      }
      completion = { authorizationCode };
    } else {
      const state = callback.state,
        code = callback.code;
      const codeSchema =
        this.#definition.family === "claude"
          ? secretSubmission.claudeOAuthCallbackCode
          : this.#definition.family === "grok"
            ? secretSubmission.grokOAuthAuthorizationCode
            : secretSubmission.oauthCallbackCode;
      if (
        !secretSubmission.oauthCallbackState.safeParse(state).success ||
        !codeSchema.safeParse(code).success
      ) {
        throw new NativeFailure("bounded");
      }
      completion = { state, code };
    }
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "complete"), {
        ...this.wire(scope),
        ...completion,
      }),
      scope,
      false,
    );
    return Object.freeze({
      operationId: result.operationId,
      accountRef: result.accountRef,
      state: result.state,
    });
  }
  async read(input: OAuthScope): Promise<OAuthReadback> {
    const scope = this.capture(input);
    const result = this.ack(
      await this.call("POST", oauthEndpoint(this.#definition, "read"), this.wire(scope)),
      scope,
      false,
    );
    return Object.freeze({
      operationId: result.operationId,
      accountRef: result.accountRef,
      state: result.state,
    });
  }
  async refresh(input: OAuthScope): Promise<OAuthRefreshReadback> {
    const scope = this.capture(input);
    const bytes = await this.call(
      "POST",
      oauthEndpoint(this.#definition, "refresh"),
      this.wire(scope),
      5000,
    );
    try {
      const r = object(decode(bytes), ["operation", "account_ref", "state"], ["refresh_ref"]);
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        !["idle", "prepared", "entered", "completed", "unknown"].includes(r.state as string)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (Object.hasOwn(r, "refresh_ref")) {
        identifier(r.refresh_ref);
      }
      return Object.freeze({
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        state: r.state as OAuthRefreshReadback["state"],
        ...(Object.hasOwn(r, "refresh_ref") ? { refreshRef: r.refresh_ref as string } : {}),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async describe(input: OAuthScope): Promise<OAuthDescriptor> {
    const scope = this.capture(input);
    const bytes = await this.call(
      "POST",
      oauthEndpoint(this.#definition, "descriptor"),
      this.wire(scope),
    );
    try {
      const r = object(
        decode(bytes),
        ["operation", "account_ref", "state", "qualification"],
        ["native"],
      );
      if (r.operation !== scope.operationId || r.account_ref !== scope.accountRef) {
        throw new NativeFailure("invalid_readback");
      }
      const logical = { operationId: scope.operationId, accountRef: scope.accountRef };
      if (r.state === "staged" && r.qualification === "pending" && !Object.hasOwn(r, "native")) {
        return Object.freeze({ ...logical, state: "staged", qualification: "pending" });
      }
      if (r.state !== "staged" || r.qualification !== "controlled-source-v1") {
        throw new NativeFailure("invalid_readback");
      }
      const native = oauthPhysical(r.native, scope.generation, this.#definition);
      return Object.freeze({
        ...logical,
        state: "qualified",
        qualification: "controlled-source-v1",
        native,
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

// Purpose-bound cleanup credential is composed separately from connect/control.
export class NativeOAuthLifecycleClient extends NativeControlHTTP implements OAuthLifecycleNative {
  readonly #owner: string;
  readonly #definition: OAuthProfileDefinition;
  constructor(
    options: NativeManagementOptions & {
      readonly ownerRef: string;
      readonly profileId?: string;
      readonly grokBrowserPolicy?: { readonly clientId: string; readonly redirectURI: string };
    },
  ) {
    super(options);
    identifier(options.ownerRef);
    this.#owner = options.ownerRef;
    const definition = oauthProfileDefinition(options.profileId ?? codexOAuthProfile.profile);
    if (!definition) {
      throw new KernelError("invalid");
    }
    this.#definition = definition;
  }
  async cleanup(
    input: OAuthScope,
    authority: OAuthCleanupAuthority,
    action: OAuthCleanupAction,
  ): Promise<OAuthCleanupReadback> {
    const scope = Object.freeze({
      consumerId: input.consumerId,
      operationId: input.operationId,
      ownerRef: input.ownerRef,
      accountRef: input.accountRef,
      generation: input.generation,
    });
    const cleanupRef = authority.cleanupRef,
      cleanupToken = authority.cleanupToken;
    this.scope(scope);
    identifier(scope.operationId);
    uuid(cleanupRef);
    uuid(cleanupToken);
    if (scope.ownerRef !== this.#owner || !["read", "erase"].includes(action)) {
      throw new NativeFailure("denied");
    }
    const bytes = await this.call("POST", oauthEndpoint(this.#definition, "cleanup"), {
      operation: scope.operationId,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
      generation: scope.generation,
      action,
      cleanup_ref: cleanupRef,
      cleanup_token: cleanupToken,
    });
    try {
      const r = object(
        decode(bytes),
        ["operation", "account_ref", "credentials_erased", "closure"],
        ["native"],
      );
      if (
        r.operation !== scope.operationId ||
        r.account_ref !== scope.accountRef ||
        typeof r.credentials_erased !== "boolean" ||
        !["pending", "closed", "unknown"].includes(r.closure as string) ||
        (r.closure === "closed" && !r.credentials_erased)
      ) {
        throw new NativeFailure("invalid_readback");
      }
      const native = Object.hasOwn(r, "native")
        ? oauthPhysical(r.native, scope.generation, this.#definition, true)
        : undefined;
      return Object.freeze({
        operationId: scope.operationId,
        accountRef: scope.accountRef,
        credentialsErased: r.credentials_erased,
        closure: r.closure as OAuthCleanupReadback["closure"],
        ...(native ? { native } : {}),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

