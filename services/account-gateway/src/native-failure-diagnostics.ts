import { KernelError } from "./domain.ts";

export type NativeFailurePhase =
  | "prepare"
  | "prepare_envelope"
  | "prepare_lifetime"
  | "native_post"
  | "native_response"
  | "receipt_recovery"
  // Streaming body and its settlement: each early stop has its own phase.
  | "stream_read"
  | "stream_canceled"
  | "stream_deadline"
  | "stream_chunk"
  | "stream_output_limit"
  | "stream_response_started"
  | "stream_incomplete"
  | "settle_recovery"
  | "settle_closure_wait"
  | "settle_not_completed"
  | "settle_effect_conflict"
  | "settle_ack"
  | "callback_input"
  | "callback_authentication"
  | "callback_body"
  | "callback_execution_authority"
  | "callback_public_admit"
  | "callback_execution_settle"
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
  // One line per context: the first reported phase is the cause, and a later
  // cleanup failure in the same request does not add a second line.
  reported?: boolean;
}
export function emitNativeFailure(
  kind: "transport" | "callback",
  error: unknown,
  diagnostic: NativeFailureContext,
  httpStatus?: number,
): void {
  if (diagnostic.reported === true) {
    return;
  }
  diagnostic.reported = true;
  try {
    const code = error instanceof KernelError ? error.code : undefined;
    console.error(
      JSON.stringify({
        event:
          kind === "transport"
            ? "gateway_native_transport_failure"
            : "gateway_native_callback_failure",
        phase: diagnostic.phase,
        ...(code && ["invalid", "unknown", "conflict", "denied", "unavailable"].includes(code)
          ? { kernel_code: code }
          : {}),
        ...(diagnostic.requestRef === undefined ? {} : { request_ref: diagnostic.requestRef }),
        ...(typeof httpStatus === "number" &&
        Number.isInteger(httpStatus) &&
        httpStatus >= 100 &&
        httpStatus <= 599
          ? { http_status: httpStatus }
          : {}),
      }),
    );
  } catch {
    /* Diagnostics cannot replace failure, cleanup, or settlement. */
  }
}
