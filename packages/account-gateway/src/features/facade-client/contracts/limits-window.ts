import { z } from "zod";

/** Canonical observed quota semantics shared by the versioned identity envelopes. */
export function limitsWindow<T extends z.ZodType<string>>(provider: T) {
  const instant = z.iso.datetime({ precision: undefined }).max(64)
    .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/)
    .refine((value) => !value.startsWith("0000-"));
  return z.strictObject({
    id: z.enum(["five_hour", "weekly", "monthly", "primary", "secondary", "unknown", "request_rate", "token_rate"]),
    provider,
    dimension: z.enum(["plan_quota", "rate_limit"]),
    unit: z.enum(["credits", "tokens", "requests", "unknown"]),
    period: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("duration"), durationSeconds: z.number().positive().max(Number.MAX_SAFE_INTEGER) }),
      z.strictObject({ kind: z.literal("monthly_billing_cycle") }),
      z.strictObject({ kind: z.literal("unknown") }),
    ]),
    label: z.enum(["5h", "Week", "Month"]).nullable(),
    usedPercent: z.number().nonnegative().nullable(),
    observedAt: instant.nullable(),
    resetAt: instant.nullable(),
  }).refine((v) => v.label !== "5h" || (v.period.kind === "duration" && v.period.durationSeconds === 18000))
    .refine((v) => v.label !== "Week" || (v.period.kind === "duration" && v.period.durationSeconds === 604800))
    .refine((v) => v.label !== "Month" || v.period.kind === "monthly_billing_cycle")
    .refine((v) => v.period.kind !== "unknown" || v.label === null);
}
