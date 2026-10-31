import type * as c from "@agent-teams/account-gateway/contracts";
import { KernelError } from "./domain.ts";
import type { AccountStatus, LimitedAccount, TrustedContext } from "./domain.ts";
import { acceptedLimitsWire } from "./limits-port.ts";
import {
  providerConnectionDefinition,
  type ProviderConnectionDefinition,
} from "./provider-connections.ts";

type CodexSnapshot = Extract<c.AccountLimits, { status: "snapshot" }>;
export interface AdmissionLimitsSource {
  readAccountLimits(input: c.AccountLimitsRequest, deadlineMs?: number): Promise<unknown>;
}
export interface AdmissionLimitsScreen {
  // Permitted accounts the native snapshot reports as exhausted, in client order.
  readonly limitedAccounts: readonly LimitedAccount[];
  // Earliest reset among the given limited accounts, bounded by the wire contract.
  retryAfterMs(accountRefs: readonly string[]): number;
}
export interface AdmissionLimits {
  screen(
    context: TrustedContext,
    accounts: readonly AccountStatus[],
  ): Promise<AdmissionLimitsScreen>;
}

// safeError retry.after upper bound (facade-client contracts).
export const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * Sub2API's Codex rule (calculateOpenAI429ResetTime), applied verbatim to the
 * native snapshot: the account-wide primary/secondary window used at or above
 * 100% with a known future reset. Usable again after the last such reset. No
 * threshold, cooldown or counter of the gateway's own. Other providers' windows
 * (for example model-scoped Claude windows) are deliberately not interpreted.
 */
export function exhaustedUntil(wire: c.AccountLimits, now: number): number | undefined {
  if (wire.status !== "snapshot") {
    return undefined;
  }
  let until: number | undefined;
  for (const window of wire.windows) {
    const reset = window.resetAt === null ? Number.NaN : Date.parse(window.resetAt);
    if (
      window.family === "codex" &&
      (window.id === "primary" || window.id === "secondary") &&
      window.usedPercent !== null &&
      window.usedPercent >= 100 &&
      reset > now
    ) {
      until = Math.max(until ?? reset, reset);
    }
  }
  return until;
}

const late = Symbol("late");
// A failed or late read is "no data"; the timer never keeps the process alive.
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof late>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(late);
      },
      Math.max(0, ms),
    );
    timer.unref();
  });
  try {
    const value = await Promise.race([work, deadline]);
    return value === late ? undefined : value;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface NativeAdmissionLimitsOptions {
  readonly codex?: AdmissionLimitsSource;
  readonly definition?: (profileId: string) => ProviderConnectionDefinition | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly readMs?: number;
  readonly budgetMs?: number;
  readonly maxReads?: number;
}
const maxEntries = 1024;
const bounded = (value: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new KernelError("invalid");
  }
  return value;
};

/**
 * Read-only admission view of the native cached Codex limits. It keeps no
 * account health: a short read-through cache of native snapshots, evaluated
 * against the current clock. Any missing, failed, late, saturated or foreign
 * snapshot is treated as admissible, so native data can only narrow selection.
 */
export class NativeAdmissionLimits implements AdmissionLimits {
  readonly #codex?: AdmissionLimitsSource;
  readonly #definition: (profileId: string) => ProviderConnectionDefinition | undefined;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #readMs: number;
  readonly #budgetMs: number;
  // Each uncached read costs one native read and its owner callbacks, which
  // share the small critical callback lane with dispatch proof and closure.
  readonly #maxReads: number;
  #reads = 0;
  readonly #cache = new Map<
    string,
    { expires: number; wire: Promise<CodexSnapshot | undefined> }
  >();
  constructor(options: NativeAdmissionLimitsOptions) {
    this.#codex = options.codex;
    this.#definition = options.definition ?? providerConnectionDefinition;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = bounded(options.ttlMs ?? 5000, 60_000);
    this.#readMs = bounded(options.readMs ?? 1000, 3000);
    this.#budgetMs = bounded(options.budgetMs ?? 2000, 5000);
    this.#maxReads = bounded(options.maxReads ?? 1, 8);
  }
  async screen(
    context: TrustedContext,
    accounts: readonly AccountStatus[],
  ): Promise<AdmissionLimitsScreen> {
    const until = new Map<string, number>(),
      limited: LimitedAccount[] = [];
    const deadline = this.#now() + this.#budgetMs;
    for (const account of accounts) {
      // Kernel selection skips non-active accounts without any native read.
      if (account.state !== "active") {
        continue;
      }
      let wire: CodexSnapshot | undefined;
      try {
        const pending = this.#snapshot(context, account);
        wire = pending && (await within(pending, deadline - this.#now()));
      } catch {
        /* A source that throws synchronously is no data, never a refusal. */
      }
      const reset = wire && exhaustedUntil(wire, this.#now());
      if (wire === undefined || reset === undefined) {
        break; // First admissible or unknown account in client order.
      }
      until.set(account.accountRef, reset);
      limited.push(
        Object.freeze({
          accountRef: account.accountRef,
          authorizationEpoch: account.epoch,
          generation: wire.physicalGeneration,
        }),
      );
    }
    const now = this.#now;
    return Object.freeze({
      limitedAccounts: Object.freeze(limited),
      retryAfterMs(accountRefs: readonly string[]) {
        const resets = accountRefs.flatMap((ref) => until.get(ref) ?? []);
        if (!resets.length) {
          return MAX_RETRY_AFTER_MS;
        }
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(Math.min(...resets) - now())));
      },
    });
  }
  // Undefined when there is nothing to read or the read lane is saturated.
  #snapshot(
    context: TrustedContext,
    account: AccountStatus,
  ): Promise<CodexSnapshot | undefined> | undefined {
    const definition = this.#definition(account.profile),
      source = this.#codex;
    if (
      !source ||
      definition?.limitsContract !== "account-limits/v1" ||
      definition.provider.identity !== "openai"
    ) {
      return undefined;
    }
    // Reconnect and lifecycle changes advance the epoch, so they miss the cache.
    const key = JSON.stringify([
      context.consumerId,
      account.ownerRef,
      account.accountRef,
      account.profile,
      account.epoch,
    ]);
    const now = this.#now(),
      cached = this.#cache.get(key);
    if (cached && cached.expires > now) {
      return cached.wire;
    }
    if (this.#reads >= this.#maxReads) {
      return undefined;
    }
    this.#reads++;
    // The async wrapper turns a synchronous source throw into "no data".
    const read = (async () =>
      source.readAccountLimits(
        {
          ownerRef: account.ownerRef,
          accountRef: account.accountRef,
          profileId: account.profile,
          expectedAuthorizationEpoch: account.epoch,
        },
        this.#readMs,
      ))();
    const wire = within(read, this.#readMs)
      .then((observed) => {
        const accepted =
          observed === undefined
            ? undefined
            : acceptedLimitsWire("account-limits/v1", observed, "openai");
        return accepted?.status === "snapshot" ? (accepted as CodexSnapshot) : undefined;
      })
      .finally(() => {
        this.#reads--;
      });
    this.#cache.delete(key);
    if (this.#cache.size >= maxEntries) {
      for (const [entry, value] of this.#cache) {
        if (value.expires <= now || this.#cache.size >= maxEntries) {
          this.#cache.delete(entry);
        }
      }
    }
    this.#cache.set(key, { expires: now + this.#ttlMs, wire });
    return wire;
  }
}
