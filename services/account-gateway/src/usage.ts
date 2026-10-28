import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { usageObservation } from "@agent-teams/account-gateway/contracts";
import type {
  UsageObservation,
  UsagePage,
  UsageQuery,
} from "@agent-teams/account-gateway/contracts";
import { KernelError } from "./domain.ts";
import type { TrustedContext } from "./domain.ts";
import { sharedCheckout } from "./service-admission.ts";
import type { Checkout } from "./service-admission.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export interface UsageJournal {
  observe(
    context: TrustedContext,
    executionRef: string,
    requestRef: string,
  ): Promise<UsageObservation | null>;
  append(context: TrustedContext, fact: UsageObservation): Promise<void>;
  list(context: TrustedContext, query: UsageQuery): Promise<UsagePage>;
}
// Every writer holds the counter lock through commit. A captured high water
// therefore cannot hide an earlier uncommitted insert or late correction.
export class PostgresUsageJournal implements UsageJournal {
  readonly #checkout: Checkout;
  readonly #key: Uint8Array;
  constructor(pool: Pool, key: Uint8Array) {
    this.#checkout = sharedCheckout(pool);
    this.#key = createHash("sha256").update(key).update("usage-cursor-v1").digest();
  }
  async observe(
    context: TrustedContext,
    executionRef: string,
    requestRef: string,
  ): Promise<UsageObservation | null> {
    const db = await this.#checkout();
    const health = { failed: false };
    const failed = (): boolean => health.failed;
    const onError = () => {
      health.failed = true;
    };
    db.on("error", onError);
    try {
      const result = await db.query<{ fact: unknown }>(
        "SELECT fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND execution_ref=$2 AND request_ref=$3 ORDER BY revision DESC LIMIT 1",
        [context.consumerId, executionRef, requestRef],
      );
      if (failed()) {
        throw new KernelError("unavailable");
      }
      const row = result.rows.at(0);
      return row === undefined ? null : usageObservation.parse(row.fact);
    } finally {
      db.removeListener("error", onError);
      db.release(failed());
    }
  }
  async append(context: TrustedContext, input: UsageObservation): Promise<void> {
    const fact = usageObservation.parse(input),
      db = await this.#checkout();
    let transaction = false;
    const health = { destroy: false };
    const destroy = (): boolean => health.destroy;
    const onError = () => {
      health.destroy = true;
    };
    db.on("error", onError);
    try {
      await db.query("BEGIN");
      transaction = true;
      await db.query("SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton FOR UPDATE");
      const previous = await db.query<{ fact: unknown }>(
        "SELECT fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND execution_ref=$2 AND request_ref=$3 AND revision=$4",
        [context.consumerId, fact.executionRef, fact.requestRef, fact.revision],
      );
      const previousRow = previous.rows.at(0);
      if (previousRow !== undefined) {
        if (JSON.stringify(usageObservation.parse(previousRow.fact)) !== JSON.stringify(fact)) {
          throw new KernelError("conflict");
        }
      } else {
        const position = await db.query<{ value: string }>(
          "UPDATE ag_kernel.usage_feed_counter SET value=value+1 WHERE singleton RETURNING value",
        );
        await db.query(
          "INSERT INTO ag_kernel.usage_observations(position,consumer,execution_ref,request_ref,revision,fact) VALUES($1,$2,$3,$4,$5,$6)",
          [
            position.rows[0].value,
            context.consumerId,
            fact.executionRef,
            fact.requestRef,
            fact.revision,
            fact,
          ],
        );
      }
      await db.query("COMMIT");
      transaction = false;
      if (destroy()) {
        throw new KernelError("unavailable");
      }
    } catch (error) {
      if (transaction) {
        try {
          await db.query("ROLLBACK");
        } catch {
          health.destroy = true;
        }
      } else {
        health.destroy = true;
      }
      throw error;
    } finally {
      db.removeListener("error", onError);
      db.release(destroy());
    }
  }
  #cursor(consumer: string, after: string, high: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify([consumer, after, high])),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  #readCursor(consumer: string, cursor: string): readonly [string, string] {
    let values: unknown;
    try {
      if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error("invalid usage cursor encoding");
      }
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.length < 29) {
        throw new Error("invalid usage cursor encoding");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      values = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      );
    } catch {
      throw new KernelError("invalid");
    }
    if (!Array.isArray(values) || values.length !== 3 || values[0] !== consumer) {
      throw new KernelError("denied");
    }
    const after: unknown = values[1],
      high: unknown = values[2];
    if (
      typeof after !== "string" ||
      !/^(0|[1-9]\d{0,18})$/.test(after) ||
      typeof high !== "string" ||
      !/^(0|[1-9]\d{0,18})$/.test(high)
    ) {
      throw new KernelError("denied");
    }
    if (BigInt(after) > BigInt(high)) {
      throw new KernelError("invalid");
    }
    return [after, high];
  }
  async list(context: TrustedContext, query: UsageQuery): Promise<UsagePage> {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new KernelError("invalid");
    }
    const previous =
      query.afterCursor !== undefined && query.afterCursor !== ""
        ? this.#readCursor(context.consumerId, query.afterCursor)
        : undefined;
    const bound =
      query.highWaterCursor !== undefined && query.highWaterCursor !== ""
        ? this.#readCursor(context.consumerId, query.highWaterCursor)
        : undefined;
    const after = previous?.[0] ?? "0";
    if (
      bound &&
      (bound[0] !== bound[1] ||
        (previous && previous[1] !== bound[1]) ||
        BigInt(after) > BigInt(bound[1]))
    ) {
      throw new KernelError("invalid");
    }
    const db = await this.#checkout();
    const health = { failed: false };
    const failed = (): boolean => health.failed;
    const onError = () => {
      health.failed = true;
    };
    db.on("error", onError);
    try {
      // A completed page begins a new captured window on its next request.
      const high =
        bound?.[1] ??
        (previous && previous[0] !== previous[1]
          ? previous[1]
          : (
              await db.query<{ value: string }>(
                "SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton",
              )
            ).rows[0].value);
      const rows = await db.query<{ position: string; fact: unknown }>(
        "SELECT position,fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND position>$2 AND position<=$3 ORDER BY position LIMIT $4",
        [context.consumerId, after, high, limit],
      );
      // Facade control responses have a hard 64KiB bound. A full count-based
      // page can exceed it with valid maximal references; never skip those rows.
      const observations: UsageObservation[] = [];
      let bytes = 0,
        last = after;
      for (const row of rows.rows) {
        const fact = usageObservation.parse(row.fact),
          size = Buffer.byteLength(JSON.stringify(fact)) + 1;
        if (bytes + size > 55_000) {
          break;
        }
        observations.push(fact);
        bytes += size;
        last = row.position;
      }
      if (observations.length === rows.rows.length && rows.rows.length < limit) {
        last = high;
      }
      const highWaterCursor = query.highWaterCursor ?? this.#cursor(context.consumerId, high, high);
      if (failed()) {
        throw new KernelError("unavailable");
      }
      return {
        observations,
        nextCursor: last === high ? highWaterCursor : this.#cursor(context.consumerId, last, high),
        highWaterCursor,
      };
    } finally {
      db.removeListener("error", onError);
      db.release(failed());
    }
  }
}

// Bounded transient parsing only: neither prompt nor response body is persisted.
// Missing/invalid terminal metadata stays unknown; transport success is not usage.
export class ResponsesUsageCapture {
  #pending = "";
  readonly #decoder = new TextDecoder();
  #dropped = false;
  #usage: Pick<
    UsageObservation,
    "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens"
  > = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null };
  push(bytes: Uint8Array): void {
    if (this.#dropped) {
      return;
    }
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    while (this.#pending.includes("\n")) {
      const end = this.#pending.indexOf("\n"),
        line = this.#pending.slice(0, end).replace(/\r$/, "");
      this.#pending = this.#pending.slice(end + 1);
      if (line.length > 1_048_576) {
        this.#dropped = true;
        this.#pending = "";
        return;
      }
      if (!line.startsWith("data:")) {
        continue;
      }
      try {
        const event: unknown = JSON.parse(line.slice(5));
        if (!record(event) || event.type !== "response.completed") {
          continue;
        }
        const response = record(event.response) ? event.response : undefined;
        const u = response !== undefined && record(response.usage) ? response.usage : undefined;
        const inputDetails = u?.input_tokens_details,
          outputDetails = u?.output_tokens_details;
        this.#usage = {
          inputTokens: numeric(u?.input_tokens),
          outputTokens: numeric(u?.output_tokens),
          cachedInputTokens: numeric(record(inputDetails) ? inputDetails.cached_tokens : undefined),
          reasoningTokens: numeric(
            record(outputDetails) ? outputDetails.reasoning_tokens : undefined,
          ),
        };
        if (
          this.#usage.cachedInputTokens !== null &&
          (this.#usage.inputTokens === null ||
            this.#usage.cachedInputTokens > this.#usage.inputTokens)
        ) {
          this.#usage.cachedInputTokens = null;
        }
        if (
          this.#usage.reasoningTokens !== null &&
          (this.#usage.outputTokens === null ||
            this.#usage.reasoningTokens > this.#usage.outputTokens)
        ) {
          this.#usage.reasoningTokens = null;
        }
      } catch {
        /* malformed usage cannot become a zero */
      }
    }
    if (this.#pending.length > 1_048_576) {
      this.#dropped = true;
      this.#pending = "";
    }
  }
  snapshot() {
    return { ...this.#usage, completeness: "partial" as const };
  }
}

export interface NativeUsage {
  source: "native_provider_response";
  state: "unknown" | "partial" | "complete";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costState: "unknown";
  finalized: boolean;
}
function optionalCounter(value: unknown): asserts value is number | undefined {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new KernelError("invalid");
  }
}
function validateNativeUsage(value: unknown): asserts value is NativeUsage {
  if (!record(value)) {
    throw new KernelError("invalid");
  }
  const r = value;
  const required = ["source", "state", "costState", "finalized"],
    optional = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"];
  if (
    required.some((key) => !Object.hasOwn(r, key)) ||
    Object.keys(r).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new KernelError("invalid");
  }
  if (
    r.source !== "native_provider_response" ||
    (r.state !== "unknown" && r.state !== "partial" && r.state !== "complete") ||
    r.costState !== "unknown" ||
    typeof r.finalized !== "boolean"
  ) {
    throw new KernelError("invalid");
  }
  optionalCounter(r.inputTokens);
  optionalCounter(r.outputTokens);
  optionalCounter(r.cachedInputTokens);
  optionalCounter(r.reasoningOutputTokens);
  if (
    (r.state === "complete" && (r.inputTokens === undefined || r.outputTokens === undefined)) ||
    (r.cachedInputTokens !== undefined &&
      (r.inputTokens === undefined || r.cachedInputTokens > r.inputTokens)) ||
    (r.reasoningOutputTokens !== undefined &&
      (r.outputTokens === undefined || r.reasoningOutputTokens > r.outputTokens))
  ) {
    throw new KernelError("invalid");
  }
}
export function nativeUsage(value: unknown): NativeUsage {
  if (!record(value)) {
    throw new KernelError("invalid");
  }
  let snapshot: Record<string, unknown>;
  try {
    snapshot = { ...value };
  } catch {
    throw new KernelError("invalid");
  }
  validateNativeUsage(snapshot);
  // Return the same validated snapshot, preserving own-key and symbol semantics.
  return Object.freeze(snapshot);
}
