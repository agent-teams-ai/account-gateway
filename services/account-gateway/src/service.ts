// Compatibility surface: pure service adapter composition is separate from
// process lifetime, startup and crash/recovery orchestration.
export {
  composeKernelBounds,
  composeServiceCleanupTurn,
  protectedReadSockets,
  composeServiceControl,
  composeServiceCachedLimits,
  composeServiceNative,
} from "./service-assembly.ts";
export {
  composeServiceRetirementReadback,
  runtimeFailureDiagnostic,
  writeRuntimeFailureDiagnostic,
  startService,
} from "./service-runtime.ts";
export type { ProcessBinding, Retirement, Service } from "./service-runtime.ts";
