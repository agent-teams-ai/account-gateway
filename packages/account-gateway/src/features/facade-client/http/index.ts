// Curated public SDK surface: never export internal transport wiring.
export * as secretSubmission from "./ingress.js";
export { GatewayError, operationPath, requestPath } from "./transport.js";
export type {
  ManagementConfig,
  ConsumerControlConfig,
  ExecutionConfig,
  CallOptions,
  NativeResponse,
  NativeRequest,
} from "./transport.js";
export {
  createManagementClient,
  createLifecycleClient,
  createConsumerControlClient,
  createExecutionClient,
  createAccountLimitsClient,
  createAccountLimitsRefreshClient,
  createAccountLimitsV2Client,
} from "./clients.js";
export type {
  LifecycleConfig,
  Connect,
  Reconnect,
  ManagementClient,
  ExecutionClient,
  ConsumerControlClient,
  LifecycleClient,
  AccountLimitsConfig,
  AccountLimitsClient,
  AccountLimitsRefreshConfig,
  AccountLimitsRefreshClient,
  AccountLimitsV2Config,
  AccountLimitsV2Client,
} from "./clients.js";
