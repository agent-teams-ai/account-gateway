import { createHash } from "node:crypto";
import { identifier, uuid } from "./domain.ts";
import type { NativeReservation, TrustedContext } from "./domain.ts";

// Version 8 binds a reservation to its irrevocable execution/request namespace.
// The native issuer and SQL compute this independently. Legacy nonces retain
// their permanent spent-reservation rows and are ineligible for retirement.
export function requestBoundNonce(
  context: TrustedContext,
  reservation: Pick<NativeReservation, "originRef" | "engineIncarnation">,
  executionRef: string,
  requestId: string,
): string {
  const consumer = context.consumerId,
    origin = reservation.originRef,
    incarnation = reservation.engineIncarnation;
  identifier(consumer);
  identifier(origin);
  uuid(incarnation);
  uuid(executionRef);
  identifier(requestId);
  const hash = createHash("sha256")
    .update(
      [
        "account-gateway/native-reservation/v2",
        consumer,
        origin,
        incarnation,
        executionRef,
        requestId,
      ].join("\0"),
      "utf8",
    )
    .digest();
  hash[6] = (hash[6] & 15) | 0x80;
  hash[8] = (hash[8] & 63) | 0x80;
  const value = hash.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
