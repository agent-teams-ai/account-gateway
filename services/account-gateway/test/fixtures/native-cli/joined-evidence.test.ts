import test from "node:test";
import assert from "node:assert/strict";
import { joinedFailure, joinedReceipt } from "./joined-evidence.ts";

void test("joined client evidence requires real terminal proofs and discards arbitrary assertion and client values", () => {
  const expected = {
    nativeCommit: "a".repeat(40),
    gatewayCommit: "b".repeat(40),
    binarySHA256: "c".repeat(64),
    version: "0.164.0",
    clientSHA256: "d".repeat(64),
    sourceHashes: {
      codexHarness: "e".repeat(64),
      codexFixture: "f".repeat(64),
      sdkHTTP: "0".repeat(64),
    },
  };
  const value = {
    phase: "completed",
    contract: "gateway-native-device-joined/v1",
    nativeHead: expected.nativeCommit,
    gatewayHead: expected.gatewayCommit,
    nativeBinarySHA256: expected.binarySHA256,
    sourceHashes: {
      harness: expected.sourceHashes.codexHarness,
      nativeFixture: expected.sourceHashes.codexFixture,
      sdkHTTP: expected.sourceHashes.sdkHTTP,
    },
    actualCLI: {
      id: "codex",
      version: expected.version,
      binarySHA256: expected.clientSHA256,
      exitCode: 0,
      providerEntries: 1,
      sqlEffect: "completed",
      nativeClosed: true,
      nativeAcknowledged: true,
      transportOccupied: false,
      usageRecorded: true,
      executionClosed: true,
      terminalWithheldUntilDurable: true,
      requestedModel: "gpt-5.4",
      usageModel: "gpt-5.4",
      output: "private-client-output",
    },
    assertion: "private-oauth-assertion",
  };
  const safe = joinedReceipt(JSON.stringify(value), "codex", expected);
  assert.equal(JSON.stringify(safe).includes("private-"), false);
  assert.equal(safe.actualCLI.requestedModel, "gpt-5.4");
  assert.equal(safe.actualCLI.usageModel, "gpt-5.4");
  for (const patch of [
    { nativeAcknowledged: false },
    { usageRecorded: false },
    { transportOccupied: true },
    { providerEntries: 2 },
    { executionClosed: false },
    { terminalWithheldUntilDurable: false },
    { requestedModel: "gpt-5.6-sol" },
    { usageModel: "gpt-5.6-sol" },
    { requestedModel: undefined },
    { usageModel: undefined },
  ]) {
    assert.throws(
      () =>
        joinedReceipt(
          JSON.stringify({ ...value, actualCLI: { ...value.actualCLI, ...patch } }),
          "codex",
          expected,
        ),
      /joined-proof-invalid/,
    );
  }
  assert.throws(
    () =>
      joinedReceipt(JSON.stringify(value), "codex", { ...expected, nativeCommit: "0".repeat(40) }),
    /joined-proof-invalid/,
  );
  for (const malformed of [null, { ...value, sourceHashes: null }, { ...value, actualCLI: null }]) {
    assert.throws(
      () => joinedReceipt(JSON.stringify(malformed), "codex", expected),
      /joined-proof-invalid/,
    );
  }
  const failed = joinedFailure(
    JSON.stringify({
      phase: "failed",
      at: "real-execution-cleanup",
      actual: "private-oauth-assertion",
      expected: "private-client-output",
      frame: "native-device-joined.ts:42:9",
      stack: "private-stack",
    }),
  );
  assert.deepEqual(failed, {
    code: "joined-driver-failed",
    at: "real-execution-cleanup",
    frame: "native-device-joined.ts:42:9",
  });
  assert.deepEqual(
    joinedFailure(
      "private-output\n" +
        JSON.stringify({
          phase: "failed",
          at: "private value with spaces",
          frame: "private-stack",
        }),
    ),
    { code: "joined-driver-failed", at: "driver" },
  );
  assert.deepEqual(
    joinedFailure(JSON.stringify({ phase: "failed", at: "refresh-token-fixture" })),
    { code: "joined-driver-failed", at: "driver" },
  );
});
