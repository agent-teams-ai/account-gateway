// Stable private-service import surface; concrete adapters retain their
// original bounded request, authorization and failure semantics.
export { NativeFailure } from "./native-client-wire.ts";
export type { NativeFailureCode } from "./native-client-wire.ts";
export type { NativeManagementOptions } from "./native-client-transport.ts";
export { NativeRetainedCustodyClient, NativeManagementClient } from "./native-client-accounts.ts";
export { NativeOAuthEnrollmentClient, NativeOAuthLifecycleClient } from "./native-client-oauth.ts";
export {
  NativeAccountLimitsClient,
  NativeAccountLimitsRefreshClient,
  NativeAccountLimitsV2Client,
  NativeAccountModelsClient,
} from "./native-client-discovery.ts";
