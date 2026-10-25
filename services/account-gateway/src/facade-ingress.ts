import { KernelError } from "./domain.ts";

// Decode once with a bounded recursive scanner so escaped duplicate names cannot
// be hidden by JSON.parse. Native still owns provider normalization/conversion.
export function strictJSON(bytes: Uint8Array, integersOnly = false): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new KernelError("invalid");
  }
  let i = 0;
  const bad = (): never => {
    throw new KernelError("invalid");
  };
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[i] ?? "") && i < text.length) i++;
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return bad();
        }
      }
      if (ch === "\\") i++;
    }
    return bad();
  };
  const value = (depth: number): void => {
    if (depth > 64) bad();
    space();
    if (text[i] === '"') {
      string();
      return;
    }
    if (text[i] === "{") {
      i++;
      space();
      const keys = new Set<string>();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        space();
        if (text[i] !== '"') bad();
        const key = string();
        if (keys.has(key)) bad();
        keys.add(key);
        space();
        if (text[i++] !== ":") bad();
        space();
        // Critical numeric authority must be an exact integer token, not a
        // fractional/exponential number rounded into one by JavaScript.
        if (
          depth === 0 &&
          key === "max_output_tokens" &&
          !/^[1-9]\d*(?=[\x20\t\r\n,}])/.test(text.slice(i))
        )
          bad();
        value(depth + 1);
        space();
        const end = text[i++];
        if (end === "}") return;
        if (end !== ",") bad();
      }
    }
    if (text[i] === "[") {
      i++;
      space();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        const end = text[i++];
        if (end === "]") return;
        if (end !== ",") bad();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i),
    );
    if (!token) bad();
    else {
      // SDK control/admission envelopes contain nonnegative integers only.
      // Check their original tokens before JSON.parse can round fractions or
      // exponents into an apparently valid saved authority value.
      if (integersOnly && /^-?\d/.test(token[0]) && !/^(?:0|[1-9]\d*)$/.test(token[0])) bad();
      i += token[0].length;
    }
  };
  value(0);
  space();
  if (i !== text.length) bad();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad();
  }
}

export function validateResponses(
  bytes: Uint8Array,
  models: readonly string[],
  tokenMaximum: number,
  modelPolicies?: readonly {
    readonly modelId: string;
    readonly reasoning: { readonly allowed: readonly string[] } | null;
  }[],
  enforceModelCapabilities = false,
): string {
  const input = strictJSON(bytes);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KernelError("invalid");
  const p = input as Record<string, unknown>;
  const critical = [
    "model",
    "stream",
    "store",
    "service_tier",
    "previous_response_id",
    "max_output_tokens",
  ];
  for (const key of Object.keys(p)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new KernelError("invalid");
    const canonical = key.normalize("NFKC").toLowerCase();
    if (critical.includes(canonical) && key !== canonical) throw new KernelError("invalid");
  }
  if (
    typeof p.model !== "string" ||
    !models.includes(p.model) ||
    p.stream !== true ||
    p.store !== false ||
    (Object.hasOwn(p, "service_tier") && p.service_tier !== "default") ||
    Object.hasOwn(p, "previous_response_id") ||
    (Object.hasOwn(p, "max_output_tokens") &&
      (!Number.isSafeInteger(p.max_output_tokens) ||
        (p.max_output_tokens as number) < 1 ||
        (p.max_output_tokens as number) > tokenMaximum))
  )
    throw new KernelError("invalid");
  const policy = modelPolicies?.find((model) => model.modelId === p.model);
  if (policy?.reasoning === null && p.reasoning !== undefined && p.reasoning !== null)
    throw new KernelError("invalid");
  if (enforceModelCapabilities && policy?.reasoning && p.reasoning !== undefined && p.reasoning !== null) {
    if (typeof p.reasoning !== "object" || Array.isArray(p.reasoning)) throw new KernelError("invalid");
    const effort = (p.reasoning as Record<string, unknown>).effort;
    if (effort !== undefined && (typeof effort !== "string" || !policy.reasoning.allowed.includes(effort)))
      throw new KernelError("invalid");
  }
  // Native transport owns tool admission and custom-to-function normalization.
  // Validated request selection, not an observation of the provider response model.
  return p.model;
}
