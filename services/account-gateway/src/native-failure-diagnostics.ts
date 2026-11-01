import { KernelError } from "./domain.ts";

export type NativeFailurePhase =
  | "prepare"
  | "prepare_envelope"
  | "prepare_lifetime"
  | "native_post"
  | "native_response"
  | "receipt_recovery"
  | "callback_input"
  | "callback_authentication"
  | "callback_body"
  | "callback_owner"
  | "callback_enrollment"
  | "callback_proof"
  | "callback_dispatch"
  | "callback_cleanup"
  | "callback_closure"
  | "admit_validation"
  | "admit_claim"
  | "admit_dispatch";
export interface NativeFailureContext {
  phase: NativeFailurePhase;
  requestRef?: string;
}
export function emitNativeFailure(
  kind: "transport" | "callback",
  error: unknown,
  diagnostic: NativeFailureContext,
  httpStatus?: number,
): void {
  try {
    const code = error instanceof KernelError ? error.code : undefined;
    console.error(
      JSON.stringify({
        event: kind === "transport"
          ? "gateway_native_transport_failure"
          : "gateway_native_callback_failure",
        phase: diagnostic.phase,
        ...(code && ["invalid", "unknown", "conflict", "denied", "unavailable"].includes(code)
          ? { kernel_code: code } : {}),
        ...(diagnostic.requestRef === undefined ? {} : { request_ref: diagnostic.requestRef }),
        ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) &&
        httpStatus >= 100 && httpStatus <= 599 ? { http_status: httpStatus } : {}),
      }),
    );
  } catch {
    /* Diagnostics cannot replace failure, cleanup, or settlement. */
  }
}
