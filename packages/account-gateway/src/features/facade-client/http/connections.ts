import * as c from "../contracts/connections-v3.js";
import * as observed from "../contracts/native-observations.js";
import { accountModelsRequest, usageQuery, type AccountModelsRequest, type UsageQuery } from "../contracts/index.js";
import * as ingress from "./connection-ingress.js";
import { id, valid, GatewayError, type transport, type CallOptions } from "./transport.js";

type JSONCall = ReturnType<typeof transport>["json"];
function checked<T extends c.ConnectionOperation>(
  result: T,
  operationId: string,
  selection?: c.ConnectionBinding,
): T {
  const bound = result.connection.connection;
  if (result.operation.operationRef !== operationId || (selection &&
    (bound.profileId !== selection.profileId || bound.methodId !== selection.methodId ||
      bound.methodRevision !== selection.methodRevision ||
      bound.configurationGeneration !== selection.configurationGeneration))) {
    throw new GatewayError("invalid_response", "effect_unknown", operationId);
  }
  return result;
}

/** One HTTP request per method. A lost sensitive ACK never triggers a replay. */
export function connectionMethods(json: JSONCall) {
  return {
    getProviderConnectionCapabilitiesV3: (options?: CallOptions): Promise<c.ProviderConnectionCapabilitiesV3> =>
      json("/v3/provider-connection-capabilities", c.providerConnectionCapabilitiesV3, "GET", undefined, options,
        {}, {}, 2_097_152),
    beginConnection: async (input: ingress.ConnectionBegin, options?: CallOptions): Promise<c.ConnectionBeginResponse> => {
      const captured = valid(ingress.connectionBegin, input);
      return checked(await json("/v3/accounts/connections/begin", c.connectionBeginResponse, "POST", captured,
        options, { operationRef: captured.operationId }), captured.operationId, captured.connection);
    },
    reconnectConnection: async (accountRef: string, input: ingress.ConnectionReconnect, options?: CallOptions): Promise<c.ConnectionBeginResponse> => {
      const captured = valid(ingress.connectionReconnect, input);
      const result = checked(await json(`/v3/accounts/${id(accountRef)}/connections/reconnect`,
        c.connectionBeginResponse, "POST", captured, options, { operationRef: captured.operationId }),
      captured.operationId, captured.connection);
      if (result.operation.state === "applied" && result.operation.result?.accountRef !== accountRef) {
        throw new GatewayError("invalid_response", "effect_unknown", captured.operationId);
      }
      return result;
    },
    submitConnection: async (input: ingress.ConnectionSubmit, options?: CallOptions): Promise<c.ConnectionOperation> => {
      const captured = valid(ingress.connectionSubmit, input);
      return checked(await json("/v3/accounts/connections/submit", c.connectionOperation, "POST", captured,
        options, { operationRef: captured.operationId }), captured.operationId);
    },
    pollConnection: async (input: c.ConnectionOperationRequest, options?: CallOptions): Promise<c.ConnectionOperation> => {
      const captured = valid(c.connectionOperationRequest, input);
      return checked(await json("/v3/accounts/connections/poll", c.connectionOperation, "POST", captured,
        options, { operationRef: captured.operationId }), captured.operationId);
    },
    readConnection: async (operationId: string, options?: CallOptions): Promise<c.ConnectionOperation> =>
      checked(await json(`/v3/operations/${id(operationId)}`, c.connectionOperation, "GET", undefined,
        options, { operationRef: operationId }), operationId),
    readAccountModelsV2: (input: AccountModelsRequest, options?: CallOptions): Promise<observed.AccountModelsV2> =>
      json("/v2/account-models/read", observed.accountModelsV2, "POST",
        valid(accountModelsRequest, input), options, {}, {}, 2_097_152),
  };
}

export function usageV2Methods(json: JSONCall) {
  return {
    observeUsageV2: (executionRef: string, requestRef: string, options?: CallOptions): Promise<observed.UsageObservationV2 | null> =>
      json(`/v2/usage/${id(executionRef)}/${id(requestRef)}`, observed.usageReadV2, "GET", undefined, options)
        .then((result) => result.observation),
    listUsageV2: (input: UsageQuery = {}, options?: CallOptions): Promise<observed.UsagePageV2> => {
      const query = valid(usageQuery, input);
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]));
      return json("/v2/usage" + (params.size ? "?" + params : ""), observed.usagePageV2, "GET", undefined, options);
    },
  };
}
