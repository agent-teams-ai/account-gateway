import test from "node:test";
import assert from "node:assert/strict";
import { readCachedAccountLimits } from "../src/limits-port.ts";
import { KernelError } from "../src/domain.ts";

const input = {
  accountRef: "account-a",
  ownerRef: "owner-a",
  profileId: "glm-coding-global-responses-apikey-v1",
  expectedAuthorizationEpoch: 1,
};
const expected = { contract: "account-limits/v2" as const, provider: "glm" as const };
const snapshot = {
  status: "snapshot" as const,
  physicalGeneration: "generation-a",
  principalVersion: "principal-a",
  revision: 1,
  scope: "subscription" as const,
  windows: [
    {
      id: "five_hour" as const,
      provider: "glm" as const,
      dimension: "plan_quota" as const,
      unit: "unknown" as const,
      period: { kind: "unknown" as const },
      label: null,
      usedPercent: null,
      observedAt: null,
      resetAt: "2026-10-23T12:00:00Z",
    },
  ],
};

void test("cached limits compares physical identity across the source await", async () => {
  let identity = "physical-a";
  await assert.rejects(
    readCachedAccountLimits(
      {
        authorize: async () => true,
        currentIdentity: async () => ({
          generation: "generation-a",
          nativePhysicalIdentity: identity,
        }),
      },
      {
        contract: "account-limits/v2",
        read: async () => {
          identity = "physical-b";
          return snapshot;
        },
      },
      input,
      expected,
    ),
    (error) => error instanceof KernelError && error.code === "denied",
  );
});
void test("cached limits reauthorizes even after an unavailable source result", async () => {
  let allowed = true;
  await assert.rejects(
    readCachedAccountLimits(
      { authorize: async () => allowed, currentIdentity: async () => ({ generation: "a" }) },
      {
        contract: "account-limits/v2",
        read: async () => {
          allowed = false;
          throw new Error("fixture");
        },
      },
      input,
      expected,
    ),
    (error) => error instanceof KernelError && error.code === "denied",
  );
});
void test("cached limits preserves known reset independently of unknown period and missing percentage", async () => {
  const result = await readCachedAccountLimits(
    { authorize: async () => true, currentIdentity: async () => ({ generation: "a" }) },
    { contract: "account-limits/v2", read: async () => snapshot },
    input,
    expected,
  );
  assert.deepEqual(result.wire, snapshot);
});
void test("cached limits rejects a foreign provider snapshot without revealing its windows", async () => {
  const result = await readCachedAccountLimits(
    { authorize: async () => true, currentIdentity: async () => ({ generation: "a" }) },
    {
      contract: "account-limits/v2",
      read: async () => ({ ...snapshot, windows: [{ ...snapshot.windows[0], provider: "kimi" }] }),
    },
    input,
    expected,
  );
  assert.deepEqual(result.wire, { status: "unavailable" });
});
