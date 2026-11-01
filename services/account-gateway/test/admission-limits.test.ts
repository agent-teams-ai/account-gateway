import { NativeAccountLimitsClient } from "../src/native-client.ts";
import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import type * as c from "@agent-teams/account-gateway/contracts";
import { MAX_RETRY_AFTER_MS, NativeAdmissionLimits } from "../src/admission-limits.ts";
import type { AccountStatus } from "../src/domain.ts";

const codex = "openai-codex-oauth-responses-v1";
const context = { consumerId: "consumer-a" };
const start = Date.parse("2026-10-31T12:00:00Z");
const minute = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const exhausted = (retryAt = start + 10 * minute) => ({
  status: "limited",
  physicalGeneration: "generation-a",
  retryAt: iso(retryAt),
});
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
// Native boundary emulator: answers like /private/native/v1/account-admission/read.
function native(answers: Record<string, () => Promise<unknown>>) {
  const reads: string[] = [];
  return {
    reads,
    source: {
      async readAccountAdmission(input: c.AccountLimitsRequest) {
        reads.push(input.accountRef + "@" + input.expectedAuthorizationEpoch);
        return (answers[input.accountRef] ?? (async () => ({ status: "unknown" })))();
      },
    },
  };
}
const refs = (screen: { limitedAccounts: readonly { accountRef: string }[] }) =>
  screen.limitedAccounts.map((l) => l.accountRef);

void test("screen keeps client order and stops reading at the first admissible account", async () => {
  const n = native({ a: async () => exhausted(), c: async () => exhausted() });
  const limits = new NativeAdmissionLimits({ codex: n.source, now: () => start });
  const screen = await limits.screen(context, [
    account("a", { epoch: 3 }),
    account("s", { state: "suspended" }),
    account("b"),
    account("c"),
  ]);
  assert.deepEqual(screen.limitedAccounts, [
    { accountRef: "a", authorizationEpoch: 3, generation: "generation-a" },
  ]);
  assert.deepEqual(n.reads, ["a@3", "b@1"]);
});

void test("failed, late, saturated, malformed and foreign snapshots never limit an account", async () => {
  for (const options of [{ readMs: 20 }, { budgetMs: 20 }]) {
    const late = new NativeAdmissionLimits({
      codex: native({ a: () => new Promise<never>(() => {}) }).source,
      ...options,
    });
    const begun = Date.now();
    assert.deepEqual(refs(await late.screen(context, [account("a")])), []);
    assert.ok(Date.now() - begun < 500);
  }
  const foreign = exhausted();
  for (const answer of [
    async () => {
      throw new Error("native unavailable");
    },
    async () => ({ status: "snapshot", windows: [{ id: "primary", usedPercent: 100 }] }),
    async () => ({ ...foreign, retryAt: "not-a-date" }),
  ]) {
    const limits = new NativeAdmissionLimits({
      codex: native({ a: answer }).source,
      now: () => start,
    });
    assert.deepEqual(refs(await limits.screen(context, [account("a")])), []);
  }
  // Only Codex profiles are read; Claude and API-key profiles keep today's behavior.
  const others = native({ a: async () => foreign });
  const limits = new NativeAdmissionLimits({ codex: others.source, now: () => start });
  for (const profile of ["anthropic-claude-oauth-messages-v1", "openai-responses-apikey-v1"]) {
    assert.deepEqual(refs(await limits.screen(context, [account("a", { profile })])), []);
  }
  assert.deepEqual(others.reads, []);
  // A saturated read lane fails open instead of queueing behind native.
  const gate: { open?: (value: unknown) => void } = {};
  const slow = native({
    a: () =>
      new Promise((resolve) => {
        gate.open = resolve;
      }),
    b: async () => exhausted(),
  });
  const busy = new NativeAdmissionLimits({ codex: slow.source, now: () => start });
  const first = busy.screen(context, [account("a")]);
  assert.deepEqual(refs(await busy.screen(context, [account("b")])), []);
  gate.open?.(exhausted());
  assert.deepEqual(refs(await first), ["a"]);
  assert.deepEqual(slow.reads, ["a@1"]);
});

void test("a synchronous source failure releases its read slot", async () => {
  let calls = 0;
  const limits = new NativeAdmissionLimits({
    codex: {
      readAccountAdmission() {
        calls++;
        if (calls === 1) {
          throw new Error("synchronous source failure");
        }
        return Promise.resolve(exhausted());
      },
    },
    now: () => start,
    ttlMs: 0,
  });
  assert.deepEqual(refs(await limits.screen(context, [account("a")])), []);
  assert.deepEqual(refs(await limits.screen(context, [account("a")])), ["a"]);
});

void test("a cached snapshot is re-evaluated against the clock and misses on a new epoch", async () => {
  let now = start;
  const n = native({ a: async () => exhausted(start + 10_000) });
  const limits = new NativeAdmissionLimits({ codex: n.source, now: () => now, ttlMs: 50_000 });
  assert.deepEqual(refs(await limits.screen(context, [account("a")])), ["a"]);
  now = start + 5000;
  assert.deepEqual(refs(await limits.screen(context, [account("a")])), ["a"]);
  now = start + 20_000;
  assert.deepEqual(refs(await limits.screen(context, [account("a")])), []);
  assert.deepEqual(n.reads, ["a@1"]);
  await limits.screen(context, [account("a", { epoch: 2 })]);
  assert.deepEqual(n.reads, ["a@1", "a@2"]);
});

void test("retry-after is the earliest reset among refused accounts within the contract hour", async () => {
  const n = native({
    a: async () => exhausted(),
    b: async () => exhausted(start + 3 * 24 * 60 * minute),
  });
  const limits = new NativeAdmissionLimits({ codex: n.source, now: () => start });
  const screen = await limits.screen(context, [account("a"), account("b")]);
  assert.deepEqual(refs(screen), ["a", "b"]);
  assert.equal(screen.retryAfterMs(["a", "b"]), 10 * minute);
  assert.equal(screen.retryAfterMs(["b"]), MAX_RETRY_AFTER_MS);
});

void test("native admission HTTP forwards only the logical selector and rejects window snapshots", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/private/native/v1/account-admission/read");
    assert.equal(req.headers.authorization, "Bearer fixture-control");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        ownerRef: "owner-a",
        accountRef: "a",
        profileId: codex,
        expectedAuthorizationEpoch: 1,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          calls++ === 0
            ? exhausted()
            : {
                status: "snapshot",
                windows: [{ usedPercent: 100, resetAt: iso(start + minute) }],
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const client = new NativeAccountLimitsClient({
    origin: `http://127.0.0.1:${address.port}`,
    consumerId: context.consumerId,
    controlCredential: "fixture-control",
  });
  const limits = new NativeAdmissionLimits({ codex: client, now: () => start, ttlMs: 0 });
  try {
    assert.deepEqual(refs(await limits.screen(context, [account("a")])), ["a"]);
    assert.deepEqual(refs(await limits.screen(context, [account("a")])), []);
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});
