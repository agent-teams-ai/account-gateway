import test from "node:test";
import assert from "node:assert/strict";
import type * as c from "@agent-teams/account-gateway/contracts";
import {
  MAX_RETRY_AFTER_MS,
  NativeAdmissionLimits,
  exhaustedUntil,
} from "../src/admission-limits.ts";
import type { AccountStatus } from "../src/domain.ts";

const codex = "openai-codex-oauth-responses-v1";
const context = { consumerId: "consumer-a" };
const start = Date.parse("2026-10-31T12:00:00Z");
const minute = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
function window(id: "primary" | "secondary", usedPercent: number | null, resetAt: number | null) {
  return {
    id,
    family: "codex" as const,
    durationSeconds: id === "primary" ? 18_000 : 604_800,
    usedPercent,
    observedAt: iso(start),
    resetAt: resetAt === null ? null : iso(resetAt),
    basis: "duration" as const,
  };
}
function snapshot(
  ...windows: ReturnType<typeof window>[]
): Extract<c.AccountLimits, { status: "snapshot" }> {
  return {
    status: "snapshot",
    physicalGeneration: "generation-a",
    principalVersion: "principal-a",
    revision: 1,
    scope: "account",
    windows,
  };
}
function account(accountRef: string, patch: Partial<AccountStatus> = {}): AccountStatus {
  return {
    accountRef,
    ownerRef: "owner-a",
    profile: codex,
    displayName: accountRef,
    state: "active",
    revision: 1,
    epoch: 1,
    ...patch,
  };
}
// Native boundary emulator: answers like /private/native/v1/account-limits/read.
function native(answers: Record<string, () => Promise<unknown>>) {
  const reads: string[] = [];
  return {
    reads,
    source: {
      async readAccountLimits(input: c.AccountLimitsRequest) {
        reads.push(input.accountRef + "@" + input.expectedAuthorizationEpoch);
        return (answers[input.accountRef] ?? (async () => ({ status: "unknown" })))();
      },
    },
  };
}

void test("exhaustion follows the Sub2API rule until the last exhausted window resets", () => {
  const weekly = start + 3 * 24 * 60 * minute;
  assert.equal(
    exhaustedUntil(
      snapshot(window("primary", 100, start + 10 * minute), window("secondary", 16, weekly)),
      start,
    ),
    start + 10 * minute,
  );
  assert.equal(
    exhaustedUntil(
      snapshot(window("primary", 100, start + 10 * minute), window("secondary", 100, weekly)),
      start,
    ),
    weekly,
  );
  for (const unlimited of [
    snapshot(window("primary", 99.9, start + 10 * minute)),
    snapshot(window("primary", 100, start - 1)),
    snapshot(window("primary", 100, start)),
    snapshot(window("primary", 100, null)),
    snapshot(window("primary", null, start + 10 * minute)),
  ]) {
    assert.equal(exhaustedUntil(unlimited, start), undefined);
  }
  assert.equal(exhaustedUntil({ status: "unknown" }, start), undefined);
});

void test("screen keeps client order and stops reading at the first admissible account", async () => {
  const exhausted = async () => snapshot(window("primary", 100, start + 10 * minute));
  const n = native({ a: exhausted, c: exhausted, d: exhausted });
  const limits = new NativeAdmissionLimits({ v1: n.source, now: () => start });
  const screen = await limits.screen(context, [
    account("a"),
    account("s", { state: "suspended" }),
    account("b"),
    account("c"),
    account("d"),
  ]);
  assert.deepEqual(screen.limitedAccounts, ["a"]);
  assert.deepEqual(n.reads, ["a@1", "b@1"]);
});

void test("failed, late, malformed and foreign snapshots never limit an account", async () => {
  const late = new NativeAdmissionLimits({
    v1: native({ a: () => new Promise<never>(() => {}) }).source,
    readMs: 20,
  });
  const begun = Date.now();
  assert.deepEqual((await late.screen(context, [account("a")])).limitedAccounts, []);
  assert.ok(Date.now() - begun < 1000);
  const foreign = snapshot(window("primary", 100, start + 10 * minute));
  for (const answer of [
    async () => {
      throw new Error("native unavailable");
    },
    async () => ({ status: "snapshot", windows: [{ id: "primary", usedPercent: 100 }] }),
    async () => ({ ...foreign, windows: [{ ...foreign.windows[0], family: "claude" }] }),
  ]) {
    const limits = new NativeAdmissionLimits({
      v1: native({ a: answer }).source,
      now: () => start,
    });
    assert.deepEqual((await limits.screen(context, [account("a")])).limitedAccounts, []);
  }
  const throwing = new NativeAdmissionLimits({
    v1: {
      readAccountLimits() {
        throw new Error("synchronous source failure");
      },
    },
  });
  assert.deepEqual((await throwing.screen(context, [account("a")])).limitedAccounts, []);
  // A profile without a native limits contract is never read.
  const none = native({ a: async () => foreign });
  const mimo = new NativeAdmissionLimits({ v1: none.source, now: () => start });
  const unsupported = account("a", { profile: "openai-responses-apikey-v1" });
  assert.deepEqual((await mimo.screen(context, [unsupported])).limitedAccounts, []);
  assert.deepEqual(none.reads, []);
});

void test("a cached snapshot is re-evaluated against the clock and misses on a new epoch", async () => {
  let now = start;
  const n = native({ a: async () => snapshot(window("primary", 100, start + minute)) });
  const limits = new NativeAdmissionLimits({ v1: n.source, now: () => now, ttlMs: 5 * minute });
  assert.deepEqual((await limits.screen(context, [account("a")])).limitedAccounts, ["a"]);
  now = start + minute / 2;
  assert.deepEqual((await limits.screen(context, [account("a")])).limitedAccounts, ["a"]);
  now = start + 2 * minute;
  assert.deepEqual((await limits.screen(context, [account("a")])).limitedAccounts, []);
  assert.deepEqual(n.reads, ["a@1"]);
  await limits.screen(context, [account("a", { epoch: 2 })]);
  assert.deepEqual(n.reads, ["a@1", "a@2"]);
});

void test("retry-after is the earliest reset among refused accounts within the contract hour", async () => {
  const n = native({
    a: async () => snapshot(window("primary", 100, start + 10 * minute)),
    b: async () => snapshot(window("secondary", 100, start + 3 * 24 * 60 * minute)),
  });
  const limits = new NativeAdmissionLimits({ v1: n.source, now: () => start });
  const screen = await limits.screen(context, [account("a"), account("b")]);
  assert.deepEqual(screen.limitedAccounts, ["a", "b"]);
  assert.equal(screen.retryAfterMs(["a", "b"]), 10 * minute);
  assert.equal(screen.retryAfterMs(["b"]), MAX_RETRY_AFTER_MS);
});
