import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountInfoReader } from "../src/account-info-port.ts";
import type { AccountInfoSource } from "../src/account-info-port.ts";
import { KernelError } from "../src/domain.ts";
import type { AccountInfoIdentity } from "../src/domain.ts";
import type { AccountInfoV2 } from "@agent-teams/account-gateway/contracts";

const missing = { status: "unknown" } as const;
const info: Extract<AccountInfoV2, { status: "available" }> = {
  status: "available",
  infoRevision: "1",
  fields: {
    email: {
      status: "known",
      value: "fixture@example.invalid",
      source: "provider_api",
      observedAt: "2026-11-19T10:00:00Z",
      freshness: "current",
    },
    accountLabel: missing,
    subscription: missing,
    credentialExpiresAt: missing,
    trainingUsage: missing,
  },
};
const identity = (): AccountInfoIdentity => ({
  accountRef: randomUUID(),
  ownerRef: "owner",
  profile: "independent-fixture",
  displayName: "Fixture",
  state: "active",
  revision: 1,
  epoch: 2,
  generation: randomUUID(),
  nativePhysicalIdentity: "physical",
  readable: true,
});
const options = () => ({ consumerId: "consumer", signal: new AbortController().signal });
function deferred() {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

void test("independent backend shares the safe contract without native/profile imports", async () => {
  const row = identity();
  let calls = 0;
  const source: AccountInfoSource = {
    async readAccountInfo(selector) {
      calls++;
      assert.equal(selector.expectedAuthorizationEpoch, 2);
      assert.equal(selector.profileId, "independent-fixture");
      return { info, generation: row.generation! };
    },
  };
  const result = await new AccountInfoReader(source).readV2(
    { observe: async () => [row] },
    { ownerRef: "owner", accountRefs: [row.accountRef] },
    options(),
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.accounts[0], {
    accountRef: row.accountRef,
    metadataRevision: 1,
    authorizationEpoch: 2,
    info,
  });
  assert.equal(JSON.stringify(result).includes("physical"), false);
});

void test("final batch fence rejects a fast row revoked while another row waits", async () => {
  const rows = [identity(), identity()],
    blocked = deferred(),
    entered = deferred();
  const source: AccountInfoSource = {
    async readAccountInfo(selector) {
      const row = rows.find((candidate) => candidate.accountRef === selector.accountRef)!;
      if (row === rows[1]) {
        entered.resolve();
        await blocked.promise;
      }
      return { info, generation: row.generation! };
    },
  };
  const reader = new AccountInfoReader(source);
  const work = reader.readV2(
    { observe: async () => rows.map((row) => ({ ...row })) },
    { ownerRef: "owner", accountRefs: rows.map((row) => row.accountRef) },
    options(),
  );
  await entered.promise;
  rows[0] = { ...rows[0], epoch: 3 };
  blocked.resolve();
  await assert.rejects(
    work,
    (error: unknown) => error instanceof KernelError && error.code === "denied",
  );
});

void test("wrong generation, backend failure and unavailable metadata preserve account revisions", async () => {
  const rows = [identity(), identity(), identity()];
  const source: AccountInfoSource = {
    async readAccountInfo(selector) {
      if (selector.accountRef === rows[0].accountRef) {
        return { info, generation: "old-generation" };
      }
      if (selector.accountRef === rows[1].accountRef) {
        throw new Error("private-backend-body");
      }
      return { info: { status: "unsupported" } };
    },
  };
  const result = await new AccountInfoReader(source).readV2(
    { observe: async () => rows },
    { ownerRef: "owner", accountRefs: rows.map((row) => row.accountRef) },
    options(),
  );
  assert.deepEqual(
    result.accounts.map((row) => row.info.status),
    ["unavailable", "unavailable", "unsupported"],
  );
  assert.ok(
    result.accounts.every((row) => row.metadataRevision === 1 && row.authorizationEpoch === 2),
  );
});

void test("owner source concurrency is bounded across concurrent batches and releases on completion", async () => {
  const row = identity(),
    entered = deferred(),
    release = deferred();
  let running = 0,
    peak = 0,
    calls = 0;
  const source: AccountInfoSource = {
    async readAccountInfo() {
      calls++;
      running++;
      peak = Math.max(peak, running);
      if (running === 2) {
        entered.resolve();
      }
      await release.promise;
      running--;
      return { info, generation: row.generation! };
    },
  };
  const reader = new AccountInfoReader(source),
    input = { ownerRef: "owner", accountRefs: [row.accountRef] };
  const read = () => reader.readV2({ observe: async () => [row] }, input, options());
  const first = read(),
    second = read();
  await entered.promise;
  assert.equal((await read()).accounts[0].info.status, "unavailable");
  release.resolve();
  await Promise.all([first, second]);
  assert.equal((await read()).accounts[0].info.status, "available");
  assert.equal(peak, 2);
  assert.equal(calls, 3);
});

void test("cancelled account info reads do not start an authority observation", async () => {
  const row = identity();
  const abort = new AbortController();
  let observations = 0,
    reads = 0;
  const reader = new AccountInfoReader({
    async readAccountInfo() {
      reads++;
      return { info, generation: row.generation! };
    },
  });
  abort.abort();
  await assert.rejects(
    reader.readV2(
      {
        async observe() {
          observations++;
          return [row];
        },
      },
      { ownerRef: row.ownerRef, accountRefs: [row.accountRef] },
      { consumerId: "consumer", signal: abort.signal },
    ),
    (error: unknown) => error instanceof KernelError && error.code === "unavailable",
  );
  assert.equal(observations, 0);
  assert.equal(reads, 0);
});

void test("cancellation during source work skips final authority read and returns no stale facts", async () => {
  const row = identity(),
    entered = deferred(),
    release = deferred();
  const abort = new AbortController();
  let observations = 0;
  const reader = new AccountInfoReader({
    async readAccountInfo() {
      entered.resolve();
      await release.promise;
      return { info, generation: row.generation! };
    },
  });
  const work = reader.readV2(
    {
      async observe() {
        observations++;
        return [row];
      },
    },
    { ownerRef: row.ownerRef, accountRefs: [row.accountRef] },
    { consumerId: "consumer", signal: abort.signal },
  );
  await entered.promise;
  abort.abort();
  release.resolve();
  await assert.rejects(
    work,
    (error: unknown) => error instanceof KernelError && error.code === "unavailable",
  );
  assert.equal(observations, 1, "only the initial authorized observation ran");
});
