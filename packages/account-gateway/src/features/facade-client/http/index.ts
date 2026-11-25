// Curated public SDK surface: never export internal transport wiring.
export * as secretSubmission from "./ingress.js";
export { GatewayError, operationPath, requestPath } from "./transport.js";
export { createAccountLimitsV3Client } from "./clients.js";
export { createLifecycleV3Client } from "./lifecycle-v3.js";
export type { LifecycleV3Client, LifecycleV3Config } from "./lifecycle-v3.js";
export type { AccountLimitsV3Client, AccountLimitsV3Config } from "./clients.js";
export type {
  ConnectionBegin,
  ConnectionReconnect,
  ConnectionSubmit,
} from "./connection-ingress.js";
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
