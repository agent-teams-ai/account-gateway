import { z } from "zod";
import * as c from "../contracts/lifecycle-v3.js";
import { lifecycleTransition, listQuery, LIFECYCLE_CAPABILITY_HEADER, LIFECYCLE_CLIENT_HEADER, type LifecycleTransition, type ListQuery } from "../contracts/index.js";
import { config, valid, transport, id, GatewayError, type CallOptions } from "./transport.js";

const lifecycleV3Config = config.extend({ role: z.enum(["management", "consumer-control"]),
  capability: z.literal(c.LIFECYCLE_V3_CAPABILITY_CONTRACT), clientContract: z.literal(c.LIFECYCLE_V3_CLIENT_CONTRACT) });
export type LifecycleV3Config = z.input<typeof lifecycleV3Config>;
export function createLifecycleV3Client(settings: LifecycleV3Config) {
  const captured = valid(lifecycleV3Config, settings);
  const { capability: _capability, clientContract: _clientContract, ...base } = captured;
  const { json } = transport(base, captured.role);
  const headers = { [LIFECYCLE_CAPABILITY_HEADER]: c.LIFECYCLE_V3_CAPABILITY_CONTRACT,
    [LIFECYCLE_CLIENT_HEADER]: c.LIFECYCLE_V3_CLIENT_CONTRACT };
  const mutate = async (accountRef: string, action: "suspend" | "resume", input: LifecycleTransition, options?: CallOptions) => {
    const parsed = valid(lifecycleTransition, input);
    const result = await json(`/v3/accounts/${id(accountRef)}/${action}`, c.lifecycleOperationV3, "POST", parsed,
      options, { operationRef: parsed.operationId }, headers);
    const account = result.state === "applied" ? result.result.account : result.account;
    if (account.accountRef !== accountRef || result.operationRef !== parsed.operationId || result.intent.action !== action ||
      result.intent.expectedMetadataRevision !== parsed.expectedMetadataRevision) throw new GatewayError("invalid_response", "effect_unknown", parsed.operationId);
    return result;
  };
  return Object.freeze({
    capability: (options?: CallOptions): Promise<c.LifecycleCapabilityV3> =>
      json("/v3/capabilities/account-lifecycle", c.lifecycleCapabilityV3, "GET", undefined, options, {}, headers),
    list: (input: ListQuery = {}, options?: CallOptions): Promise<c.LifecycleAccountsV3> => {
      const query = valid(listQuery, input);
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      return json("/v3/accounts" + (params.size ? "?" + params : ""), c.lifecycleAccountsV3, "GET", undefined, options, {}, headers);
    },
    get: async (accountRef: string, options?: CallOptions): Promise<c.LifecycleAccountV3> => {
      const result = await json(`/v3/accounts/${id(accountRef)}`, c.lifecycleAccountV3, "GET", undefined, options, {}, headers);
      if (result.accountRef !== accountRef) throw new GatewayError("invalid_response", "effect_unknown");
      return result;
    },
    suspend: (accountRef: string, input: LifecycleTransition, options?: CallOptions) => mutate(accountRef, "suspend", input, options),
    resume: (accountRef: string, input: LifecycleTransition, options?: CallOptions) => mutate(accountRef, "resume", input, options),
    operation: (operationId: string, options?: CallOptions): Promise<c.LifecycleOperationV3> =>
      json(`/v3/lifecycle/operations/${id(operationId)}`, c.lifecycleOperationV3, "GET", undefined, options,
        { operationRef: operationId }, headers),
  });
}
export type LifecycleV3Client = ReturnType<typeof createLifecycleV3Client>;
