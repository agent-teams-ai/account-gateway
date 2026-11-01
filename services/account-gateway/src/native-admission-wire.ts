import { reference } from "@agent-teams/account-gateway/contracts";

/** Private native policy result. No provider windows or thresholds cross here. */
export type NativeAccountAdmission =
  | { readonly status: "limited"; readonly physicalGeneration: string; readonly retryAt: string }
  | { readonly status: "available" | "unknown" | "unsupported" | "unavailable" };

export function acceptedNativeAdmission(value: unknown): NativeAccountAdmission | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const wire = value as Record<string, unknown>;
  if (wire.status === "limited") {
    if (
      Object.keys(wire).length !== 3 ||
      !reference.safeParse(wire.physicalGeneration).success ||
      typeof wire.retryAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.+Z$/.test(wire.retryAt) ||
      !Number.isFinite(Date.parse(wire.retryAt))
    ) {
      return undefined;
    }
    return value as NativeAccountAdmission;
  }
  if (
    Object.keys(wire).length === 1 &&
    ["available", "unknown", "unsupported", "unavailable"].includes(wire.status as string)
  ) {
    return value as NativeAccountAdmission;
  }
  return undefined;
}
