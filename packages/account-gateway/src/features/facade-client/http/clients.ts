import { z } from "zod";
import * as c from "../contracts/index.js";
import { connect, reconnect, oauthComplete } from "./ingress.js";
import type { OAuthComplete } from "./ingress.js";
import {
  config,
  transport,
  valid,
  id,
  GatewayError,
  operationPath,
  requestPath,
} from "./transport.js";
import type {
  ManagementConfig,
  ConsumerControlConfig,
  ExecutionConfig,
  CallOptions,
} from "./transport.js";

// Consumer-facing capability factories own only paths, requests and wire types.
const lifecycleConfig = config.extend({
  role: z.enum(["management", "consumer-control"]),
  capability: z.literal(c.LIFECYCLE_CAPABILITY_CONTRACT),
  clientContract: z.literal(c.LIFECYCLE_CLIENT_CONTRACT),
});
export type LifecycleConfig = z.input<typeof lifecycleConfig>;
export type Connect = z.infer<typeof connect>;
export type Reconnect = z.infer<typeof reconnect>;
function accountClient(
  settings: ManagementConfig | ConsumerControlConfig,
  role: "management" | "consumer-control",
) {
  const { json } = transport(settings, role);
  const mutate = (
    path: string,
    method: string,
    input: { operationId: string },
    options?: CallOptions,
    schema = c.accountOperation,
  ) => json(path, schema, method, input, options, { operationRef: input.operationId });
  return {
    json,
    client: Object.freeze({
      readAccountModels: (
        input: c.AccountModelsRequest,
        options?: CallOptions,
      ): Promise<c.AccountModels> =>
        json(
          "/v1/account-models/read",
          c.accountModels,
          "POST",
          valid(c.accountModelsRequest, input),
          options,
        ),
      getProviderConnectionCapabilities: (
        options?: CallOptions,
      ): Promise<c.ProviderConnectionCapabilities> =>
        json(
          "/v1/provider-connection-capabilities",
          c.providerConnectionCapabilities,
          "GET",
          undefined,
          options,
        ),
      profiles: (options?: CallOptions) =>
        json("/v1/profiles", c.profiles, "GET", undefined, options),
      list: (input: c.ListQuery = {}, options?: CallOptions) => {
        const entries: [string, c.ListQuery[keyof c.ListQuery]][] = Object.entries(
          valid(c.listQuery, input),
        );
        const query = new URLSearchParams(
          entries
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        );
        return json(
          query.size ? `/v1/accounts?${query}` : "/v1/accounts",
          c.accounts,
          "GET",
          undefined,
          options,
        );
      },
      get: (accountRef: string, options?: CallOptions) =>
        json(`/v1/accounts/${id(accountRef)}`, c.account, "GET", undefined, options),
      connect: (input: Connect, options?: CallOptions) =>
        mutate("/v1/accounts", "POST", valid(connect, input), options),
      // One call, no automatic retry or readback. A lost Begin URL is not rebuilt.
      beginOAuth: (input: c.OAuthBegin, options?: CallOptions): Promise<c.OAuthBeginResponse> => {
        const captured = valid(c.oauthBegin, input);
        return json("/v1/accounts/oauth/begin", c.oauthBeginResponse, "POST", captured, options, {
          operationRef: captured.operationId,
        });
      },
      // One fresh sensitive POST; duplicate/readback cannot rebuild a Begin URL.
      beginOAuthReconnect: (
        accountRef: string,
        input: c.OAuthReconnect,
        options?: CallOptions,
      ): Promise<c.OAuthBeginResponse> => {
        const captured = valid(c.oauthReconnect, input);
        return json(
          `/v1/accounts/${id(accountRef)}/reconnect`,
          c.oauthBeginResponse,
          "POST",
          captured,
          options,
          { operationRef: captured.operationId },
        );
      },
      // Sensitive POST only. Lost completion ACKs require ordinary readback.
      completeOAuth: (input: OAuthComplete, options?: CallOptions): Promise<c.Operation> => {
        const captured = valid(oauthComplete, input);
        return json("/v1/accounts/oauth/complete", c.accountOperation, "POST", captured, options, {
          operationRef: captured.operationId,
        });
      },
      // Explicit mutation. Native owns provider polling, throttling and exchange.
      pollDeviceOAuth: (input: c.OAuthPoll, options?: CallOptions): Promise<c.Operation> => {
        const captured = valid(c.oauthPoll, input);
        return json("/v1/accounts/oauth/poll", c.accountOperation, "POST", captured, options, {
          operationRef: captured.operationId,
        });
      },
      readOAuth: (operationId: string, options?: CallOptions): Promise<c.Operation> =>
        json(operationPath(operationId), c.accountOperation, "GET", undefined, options, {
          operationRef: operationId,
        }),
      rename: (accountRef: string, input: c.Rename, options?: CallOptions) =>
        mutate(`/v1/accounts/${id(accountRef)}`, "PATCH", valid(c.rename, input), options),
      reconnect: (accountRef: string, input: Reconnect, options?: CallOptions) =>
        mutate(
          `/v1/accounts/${id(accountRef)}/reconnect`,
          "POST",
          valid(reconnect, input),
          options,
        ),
      disable: (accountRef: string, input: c.Disable, options?: CallOptions) =>
        mutate(`/v1/accounts/${id(accountRef)}/disable`, "POST", valid(c.disable, input), options),
      retirement: async (
        accountRef: string,
        operationId: string,
        options?: CallOptions,
      ): Promise<c.AccountRetirement> => {
        const account = id(accountRef),
          operation = id(operationId);
        const result = await json(
          `/v1/accounts/${account}/retirement/${operation}`,
          c.accountRetirement,
          "GET",
          undefined,
          options,
          { operationRef: operationId },
        );
        if (result.account.accountRef !== accountRef || result.operationRef !== operationId) {
          throw new GatewayError("invalid_response", "effect_unknown", operationId);
        }
        return result;
      },
      policyClosure: (operationId: string, options?: CallOptions): Promise<c.PolicyUseClosure> =>
        json(
          `/v1/policy-fences/${id(operationId)}/closure`,
          c.policyUseClosure,
          "GET",
          undefined,
          options,
          { operationRef: operationId },
        ),
      operation: (operationId: string, options?: CallOptions) =>
        json(operationPath(operationId), c.operation, "GET", undefined, options, {
          operationRef: operationId,
        }),
      fence: (input: c.Fence, options?: CallOptions) =>
        mutate(
          "/v1/policy-fences",
          "POST",
          valid(c.fence, input),
          options,
          c.acknowledgementOperation,
        ),
    }),
  };
}
export function createManagementClient(settings: ManagementConfig) {
  const { client, json } = accountClient(settings, "management");
  return Object.freeze({
    ...client,
    prepare: (input: c.Prepare, options?: CallOptions) => {
      const parsed = valid(c.prepare, input);
      return json("/v1/executions", c.preparationOperation, "POST", parsed, options, {
        operationRef: parsed.operationId,
      });
    },
  });
}
export function createLifecycleClient(settings: LifecycleConfig) {
  const captured = valid(lifecycleConfig, settings);
  const base: ManagementConfig | ConsumerControlConfig = {
    role: captured.role,
    origin: captured.origin,
    token: captured.token,
    responseBytes: captured.responseBytes,
    timeoutMs: captured.timeoutMs,
    bufferBytes: captured.bufferBytes,
  };
  const { json } = transport(base, captured.role);
  const headers = {
    [c.LIFECYCLE_CAPABILITY_HEADER]: c.LIFECYCLE_CAPABILITY_CONTRACT,
    [c.LIFECYCLE_CLIENT_HEADER]: c.LIFECYCLE_CLIENT_CONTRACT,
  };
  const mutate = async (
    accountRef: string,
    action: "suspend" | "resume",
    input: c.LifecycleTransition,
    options?: CallOptions,
  ): Promise<c.LifecycleOperation> => {
    const parsed = valid(c.lifecycleTransition, input);
    const result = await json(
      `/v2/accounts/${id(accountRef)}/${action}`,
      c.lifecycleOperation,
      "POST",
      parsed,
      options,
      { operationRef: parsed.operationId },
      headers,
    );
    if (
      (result.state === "applied" ? result.result.account : result.account).accountRef !==
        accountRef ||
      result.intent.accountRef !== accountRef ||
      result.intent.action !== action ||
      result.intent.expectedMetadataRevision !== parsed.expectedMetadataRevision
    ) {
      throw new GatewayError("invalid_response", "effect_unknown", parsed.operationId);
    }
    return result;
  };
  return Object.freeze({
    capability: (options?: CallOptions) =>
      json(
        "/v2/capabilities/account-lifecycle",
        c.lifecycleCapability,
        "GET",
        undefined,
        options,
        {},
        headers,
      ),
    list: (input: c.ListQuery = {}, options?: CallOptions) => {
      const entries: [string, c.ListQuery[keyof c.ListQuery]][] = Object.entries(
        valid(c.listQuery, input),
      );
      const query = new URLSearchParams(
        entries
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );
      return json(
        query.size ? `/v2/accounts?${query}` : "/v2/accounts",
        c.lifecycleAccounts,
        "GET",
        undefined,
        options,
        {},
        headers,
      );
    },
    get: async (accountRef: string, options?: CallOptions) => {
      const result = await json(
        `/v2/accounts/${id(accountRef)}`,
        c.lifecycleAccount,
        "GET",
        undefined,
        options,
        {},
        headers,
      );
      if (result.accountRef !== accountRef) {
        throw new GatewayError("invalid_response", "effect_unknown");
      }
      return result;
    },
    suspend: (accountRef: string, input: c.LifecycleTransition, options?: CallOptions) =>
      mutate(accountRef, "suspend", input, options),
    resume: (accountRef: string, input: c.LifecycleTransition, options?: CallOptions) =>
      mutate(accountRef, "resume", input, options),
    operation: (operationId: string, options?: CallOptions) =>
      json(
        `/v2/operations/${id(operationId)}`,
        c.lifecycleOperation,
        "GET",
        undefined,
        options,
        { operationRef: operationId },
        headers,
      ),
  });
}
const runAccessResponse = z
  .strictObject({
    operation: c.preparationOperation,
    bearer: z.string().regex(/^[A-Za-z0-9._~-]{16,1024}$/),
    admission: c.admission,
  })
  .refine(
    (v) =>
      v.operation.state === "applied" &&
      v.operation.result?.kind === "execution" &&
      v.operation.result.accountRef === v.admission.accountRef &&
      v.operation.result.authorizationEpoch === v.admission.authorizationEpoch &&
      v.operation.result.deadline === v.admission.expiresAt,
  );
const consumerList = c.listQuery.extend({ ownerRef: c.reference });
export function createConsumerControlClient(settings: ConsumerControlConfig) {
  const { client, json } = accountClient(settings, "consumer-control");
  return Object.freeze({
    ...client,
    observeUsage: (
      executionRef: string,
      requestRef: string,
      options?: CallOptions,
    ): Promise<c.UsageObservation | null> =>
      json(
        `/v1/usage/${id(executionRef)}/${id(requestRef)}`,
        c.usageRead,
        "GET",
        undefined,
        options,
      ).then((result) => result.observation),
    listUsage: (input: c.UsageQuery = {}, options?: CallOptions): Promise<c.UsagePage> => {
      const query = valid(c.usageQuery, input);
      const params = new URLSearchParams();
      if (query.afterCursor !== undefined && query.afterCursor !== "") {
        params.set("afterCursor", query.afterCursor);
      }
      if (query.highWaterCursor !== undefined && query.highWaterCursor !== "") {
        params.set("highWaterCursor", query.highWaterCursor);
      }
      if (query.limit !== undefined && query.limit !== 0) {
        params.set("limit", String(query.limit));
      }
      return json(
        "/v1/usage" + (params.size ? "?" + params : ""),
        c.usagePage,
        "GET",
        undefined,
        options,
      );
    },
    list: (input: c.ListQuery & { ownerRef: string }, options?: CallOptions) =>
      client.list(valid(consumerList, input), options),
    runAccess: (input: c.Prepare, options?: CallOptions) => {
      const parsed = valid(c.prepare, input);
      return json("/internal/v1/run-access", runAccessResponse, "POST", parsed, options, {
        operationRef: parsed.operationId,
      });
    },
  });
}
export function createExecutionClient(settings: ExecutionConfig) {
  const { json, stream } = transport(settings, "execution");
  return Object.freeze({
    request: stream,
    status: (executionRef: string, requestId: string, options?: CallOptions) =>
      json(requestPath(executionRef, requestId), c.requestStatus, "GET", undefined, options, {
        requestRef: requestId,
      }),
    close: (executionRef: string, input: c.Close, options?: CallOptions) => {
      const parsed = valid(c.close, input);
      return json(
        `/v1/executions/${id(executionRef)}/close`,
        c.acknowledgementOperation,
        "POST",
        parsed,
        options,
        { operationRef: parsed.operationId },
      );
    },
    operation: (operationId: string, options?: CallOptions) =>
      json(operationPath(operationId), c.operation, "GET", undefined, options, {
        operationRef: operationId,
      }),
  });
}
export type ManagementClient = ReturnType<typeof createManagementClient>;
export type ExecutionClient = ReturnType<typeof createExecutionClient>;
export type ConsumerControlClient = ReturnType<typeof createConsumerControlClient>;
export type LifecycleClient = ReturnType<typeof createLifecycleClient>;

const accountLimitsConfig = config.extend({
  role: z.enum(["management", "consumer-control"]),
  responseBytes: z.number().int().min(1024).max(262144).default(262144),
  timeoutMs: z.number().int().min(1).max(3000).default(3000),
});
export type AccountLimitsConfig = z.input<typeof accountLimitsConfig>;
/** Server-only cached reads. No retry, credential refresh or provider request. */
export function createAccountLimitsClient(settings: AccountLimitsConfig) {
  const captured = valid(accountLimitsConfig, settings);
  const { json } = transport(captured, captured.role);
  return Object.freeze({
    getAccountLimitsCapabilities: (options?: CallOptions): Promise<c.AccountLimitsCapabilities> =>
      json(
        "/v1/capabilities/account-limits",
        c.accountLimitsCapabilities,
        "GET",
        undefined,
        options,
      ),
    readAccountLimits: (
      input: c.AccountLimitsRequest,
      options?: CallOptions,
    ): Promise<c.AccountLimits> =>
      json(
        "/v1/account-limits/read",
        c.accountLimits,
        "POST",
        valid(c.accountLimitsRequest, input),
        options,
      ),
  });
}
export type AccountLimitsClient = ReturnType<typeof createAccountLimitsClient>;

const accountLimitsRefreshConfig = accountLimitsConfig.extend({
  timeoutMs: z.number().int().min(1).max(10000).default(10000),
});
export type AccountLimitsRefreshConfig = z.input<typeof accountLimitsRefreshConfig>;
/** Explicit quota metadata refresh, bounded and never retried. */
export function createAccountLimitsRefreshClient(settings: AccountLimitsRefreshConfig) {
  const captured = valid(accountLimitsRefreshConfig, settings);
  const { json } = transport(captured, captured.role);
  return Object.freeze({
    getAccountLimitsRefreshCapabilities: (
      options?: CallOptions,
    ): Promise<c.AccountLimitsRefreshCapabilities> =>
      json(
        "/v1/capabilities/account-limits-refresh",
        c.accountLimitsRefreshCapabilities,
        "GET",
        undefined,
        options,
      ),
    refreshAccountLimits: (
      input: c.AccountLimitsRequest,
      options?: CallOptions,
    ): Promise<c.AccountLimits> =>
      json(
        "/v1/account-limits/refresh",
        c.accountLimits,
        "POST",
        valid(c.accountLimitsRequest, input),
        options,
      ),
  });
}
export type AccountLimitsRefreshClient = ReturnType<typeof createAccountLimitsRefreshClient>;

const accountLimitsV2Config = accountLimitsConfig.extend({
  contract: z.literal(c.ACCOUNT_LIMITS_V2_CONTRACT),
});
export type AccountLimitsV2Config = z.input<typeof accountLimitsV2Config>;
/** Version selected by declared capability; this client never probes v1 or retries. */
export function createAccountLimitsV2Client(settings: AccountLimitsV2Config) {
  const captured = valid(accountLimitsV2Config, settings);
  const { contract: _contract, ...transportConfig } = captured;
  const { json } = transport(transportConfig, captured.role);
  return Object.freeze({
    getAccountLimitsCapabilities: (options?: CallOptions): Promise<c.AccountLimitsV2Capabilities> =>
      json(
        "/v2/capabilities/account-limits",
        c.accountLimitsV2Capabilities,
        "GET",
        undefined,
        options,
      ),
    readAccountLimits: (
      input: c.AccountLimitsRequest,
      options?: CallOptions,
    ): Promise<c.AccountLimitsV2> =>
      json(
        "/v2/account-limits/read",
        c.accountLimitsV2,
        "POST",
        valid(c.accountLimitsRequest, input),
        options,
      ),
  });
}
export type AccountLimitsV2Client = ReturnType<typeof createAccountLimitsV2Client>;
