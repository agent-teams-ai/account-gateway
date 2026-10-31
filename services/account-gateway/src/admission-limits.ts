import type * as c from "@agent-teams/account-gateway/contracts";
import type { AccountStatus, TrustedContext } from "./domain.ts";
import { acceptedLimitsWire } from "./limits-port.ts";
import {
  providerConnectionDefinition,
  type ProviderConnectionDefinition,
} from "./provider-connections.ts";

type LimitsWire = c.AccountLimits | c.AccountLimitsV2;
export interface AdmissionLimitsSource {
  readAccountLimits(input: c.AccountLimitsRequest, deadlineMs?: number): Promise<unknown>;
}
export interface AdmissionLimitsScreen {
  // Permitted accounts the native snapshot reports as exhausted, in client order.
  readonly limitedAccounts: readonly string[];
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
 * Sub2API's exhaustion rule (calculateOpenAI429ResetTime): a window used at or
 * above 100% with a known future reset. The account is usable again only after
 * its last exhausted window resets. No threshold or cooldown is added here.
 */
export function exhaustedUntil(wire: LimitsWire, now: number): number | undefined {
  if (wire.status !== "snapshot") {
    return undefined;
  }
  let until: number | undefined;
  for (const window of wire.windows) {
    const reset = window.resetAt === null ? Number.NaN : Date.parse(window.resetAt);
    if (window.usedPercent !== null && window.usedPercent >= 100 && reset > now) {
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
  readonly v1?: AdmissionLimitsSource;
  readonly v2?: AdmissionLimitsSource;
  readonly definition?: (profileId: string) => ProviderConnectionDefinition | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly readMs?: number;
  readonly budgetMs?: number;
}
const maxEntries = 1024;

/**
 * Read-only admission view of the native cached account limits. It keeps no
 * account health: a short read-through cache of native snapshots, evaluated
 * against the current clock. Any missing, failed, late or foreign snapshot is
 * treated as admissible, so the native source can only narrow selection.
 */
export class NativeAdmissionLimits implements AdmissionLimits {
  readonly #v1?: AdmissionLimitsSource;
  readonly #v2?: AdmissionLimitsSource;
  readonly #definition: (profileId: string) => ProviderConnectionDefinition | undefined;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #readMs: number;
  readonly #budgetMs: number;
  readonly #cache = new Map<string, { expires: number; wire: Promise<LimitsWire | undefined> }>();
  constructor(options: NativeAdmissionLimitsOptions) {
    this.#v1 = options.v1;
    this.#v2 = options.v2;
    this.#definition = options.definition ?? providerConnectionDefinition;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5000;
    this.#readMs = options.readMs ?? 1000;
    this.#budgetMs = options.budgetMs ?? 2000;
  }
  async screen(
    context: TrustedContext,
    accounts: readonly AccountStatus[],
  ): Promise<AdmissionLimitsScreen> {
    const until = new Map<string, number>();
    const deadline = this.#now() + this.#budgetMs;
    for (const account of accounts) {
      // Kernel selection skips non-active accounts without any native read.
      if (account.state !== "active") {
        continue;
      }
      let wire: LimitsWire | undefined;
      try {
        const pending = this.#snapshot(context, account);
        wire = pending && (await within(pending, deadline - this.#now()));
      } catch {
        /* A source that throws synchronously is no data, never a refusal. */
      }
      const reset = wire && exhaustedUntil(wire, this.#now());
      if (reset === undefined) {
        break; // First admissible or unknown account in client order.
      }
      until.set(account.accountRef, reset);
    }
    const now = this.#now;
    return Object.freeze({
      limitedAccounts: Object.freeze([...until.keys()]),
      retryAfterMs(accountRefs: readonly string[]) {
        const resets = accountRefs.flatMap((ref) => until.get(ref) ?? []);
        if (!resets.length) {
          return MAX_RETRY_AFTER_MS;
        }
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(Math.min(...resets) - now())));
      },
    });
  }
  // Undefined when the profile has no native limits source to read.
  #snapshot(
    context: TrustedContext,
    account: AccountStatus,
  ): Promise<LimitsWire | undefined> | undefined {
    const definition = this.#definition(account.profile);
    if (!definition || definition.limitsContract === "none") {
      return undefined;
    }
    const contract = definition.limitsContract,
      source = contract === "account-limits/v1" ? this.#v1 : this.#v2;
    if (!source) {
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
    const wire = within(
      source.readAccountLimits(
        {
          ownerRef: account.ownerRef,
          accountRef: account.accountRef,
          profileId: account.profile,
          expectedAuthorizationEpoch: account.epoch,
        },
        this.#readMs,
      ),
      this.#readMs,
    ).then((observed) =>
      observed === undefined
        ? undefined
        : acceptedLimitsWire(contract, observed, definition.provider.identity),
    );
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
