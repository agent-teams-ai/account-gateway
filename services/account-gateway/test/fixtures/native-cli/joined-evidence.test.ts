import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  joinedFailure,
  joinedReceipt,
  joinedProviderProfiles,
  joinedProviderReceipt,
  joinedNativeProviderReceipt,
  joinedSandboxQualification,
} from "./joined-evidence.ts";
import { CommandFailure, command } from "./joined-command.ts";

const sandboxQualification = {
  contract: "codex-read-only-sandbox/v1",
  backend: "bubblewrap",
  childExecuted: true,
  readSucceeded: true,
  workspaceWriteDenied: true,
  outsideWriteDenied: true,
  loopbackTCPDenied: true,
  noNewPrivileges: true,
};

void test("sandbox evidence requires actual read and denial proofs, not child startup failure", async (t) => {
  assert.deepEqual(joinedSandboxQualification(sandboxQualification), sandboxQualification);
  for (const [name, value] of [
    ["missing proof", undefined],
    ["unsupported backend", { ...sandboxQualification, backend: "none" }],
    ["child never started", { ...sandboxQualification, childExecuted: false }],
    ["child read failed", { ...sandboxQualification, readSucceeded: false }],
    ["workspace write succeeded", { ...sandboxQualification, workspaceWriteDenied: false }],
    ["outside write succeeded", { ...sandboxQualification, outsideWriteDenied: false }],
    ["network access succeeded", { ...sandboxQualification, loopbackTCPDenied: false }],
    ["missing no_new_privs", { ...sandboxQualification, noNewPrivileges: false }],
    ["string is not a denial", { ...sandboxQualification, loopbackTCPDenied: "true" }],
    ["unapproved diagnostic", { ...sandboxQualification, stdout: "private-child-output" }],
  ] as const) {
    await t.test(name, () => {
      assert.throws(() => joinedSandboxQualification(value), { message: "joined-proof-invalid" });
    });
  }
});

void test("joined client evidence requires real terminal proofs and discards arbitrary assertion and client values", async (t) => {
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

  const child = fileURLToPath(new URL("./joined-command-fixture.ts", import.meta.url));
  const runChild = (mode: string, stdout = "", stderr = "", timeout = 5000) =>
    command(process.execPath, [child, mode, stdout, stderr], {}, { timeout });
  const diagnostic =
    JSON.stringify({
      event: "gateway_native_callback_failure",
      phase: "callback_execution_authority",
      kernel_code: "denied",
    }) + "\n";
  const proof = JSON.stringify(value) + "\n";

  await t.test("real child stderr diagnostics do not enter its strict stdout proof", async () => {
    const stdout = await runChild("success", proof, diagnostic);
    assert.equal(stdout, proof);
    assert.deepEqual(joinedReceipt(stdout, "codex", expected), safe);
  });
  await t.test(
    "multiple or malformed stdout proofs remain rejected beside stderr diagnostics",
    async () => {
      for (const raw of [proof + proof, "not-json\n"]) {
        const stdout = await runChild("success", raw, diagnostic);
        assert.throws(() => joinedReceipt(stdout, "codex", expected), /joined-proof-invalid/);
      }
    },
  );
  await t.test("combined stdout and stderr still spend the original four MiB bound", async () => {
    await assert.rejects(runChild("overflow"), CommandFailure);
  });
  await t.test(
    "real child failure keeps bounded stderr in the existing private sanitizer",
    async () => {
      const raw =
        JSON.stringify({
          phase: "failed",
          at: "real-execution-cleanup",
          frame: "native-device-joined.ts:42:9",
          assertion: "SECRET_STDOUT",
        }) + "\n";
      await assert.rejects(runChild("failure", raw, "SECRET_STDERR\n"), (error: unknown) => {
        assert.ok(error instanceof CommandFailure);
        assert.equal(error.output.includes("SECRET_STDERR"), true);
        assert.equal(error.output.includes("SECRET_STDOUT"), true);
        const sanitized = joinedFailure(error.output);
        assert.deepEqual(sanitized, {
          code: "joined-driver-failed",
          at: "real-execution-cleanup",
          frame: "native-device-joined.ts:42:9",
        });
        assert.equal(JSON.stringify(sanitized).includes("SECRET"), false);
        return true;
      });
    },
  );
  await t.test("child timeout still terminates the detached command", async () => {
    await assert.rejects(runChild("wait", "", "", 100), CommandFailure);
  });
});

void test("provider evidence keeps native-only proofs separate from six real RR tool/schema receipts", () => {
  const expected = {
    nativeCommit: "a".repeat(40),
    gatewayCommit: "b".repeat(40),
    binarySHA256: "c".repeat(64),
    sourceHashes: {
      providerHarness: "d".repeat(64),
      providerFixture: "e".repeat(64),
      sdkHTTP: "f".repeat(64),
    },
    reviewRouterCommit: "1".repeat(40),
    preloadSHA256: "2".repeat(64),
    relayAdapterSHA256: "3".repeat(64),
    actionRef: "4".repeat(40),
    actionArchiveSHA256: "5".repeat(64),
    clientSHA256: "6".repeat(64),
    version: "0.133.0",
  };
  const value = {
    phase: "completed",
    contract: "gateway-native-provider-joined/v1",
    nativeHead: expected.nativeCommit,
    gatewayBaseHead: expected.gatewayCommit,
    nativeBinarySHA256: expected.binarySHA256,
    sourceHashes: {
      harness: expected.sourceHashes.providerHarness,
      nativeFixture: expected.sourceHashes.providerFixture,
      sdkHTTP: expected.sourceHashes.sdkHTTP,
    },
    nativeHTTP: true,
    gatewayFacadeAndSDK: true,
    rrAcceptance: true,
    actualPostgreSQL: true,
    providerShapedFixture: true,
    liveProviderAccount: false,
    providers: joinedProviderProfiles.map(([provider]) => provider),
    controlledTextAndFunctionToolRoundTrip: true,
    officialAnthropicMessagesAndSchema: true,
    officialGeminiChatSchemaAndAuthenticatedContinuation: true,
    nativeAccountInfoObservedAtAndProvenance: true,
    dynamicOpenRouterDiscoveryAndDispatch: true,
    dynamicOpenRouterAuthoritativeRemoval: true,
    dynamicOpenRouterQualifiedReasoning: true,
    dynamicOpenRouterImmutableAnchor: true,
    minimaxReasoningContentRoundTrip: true,
    reconnectRetainsAccount: true,
    canonicalErasure: true,
    grokRefresh: true,
    inertReadProviderCalls: 0,
    wrongOwnerDenied: true,
    receiptPath: "/private-receipt-path",
    rrReceipts: joinedProviderProfiles.map(([, profileId, model]) => ({
      profileId,
      model,
      actionRef: expected.actionRef,
      actionArchiveSHA256: expected.actionArchiveSHA256,
      codexBinarySHA256: expected.clientSHA256,
      codexVersion: expected.version,
      providerEntries: 2,
      streamCompletions: 2,
      structuredOutputRequests: 2,
      declaredFunctionTools: 3,
      declaredCustomTools: 1,
      returnedFunctionTools: 1,
      returnedCustomTools: 1,
      reasoningOmitted: true,
      fastOmitted: true,
      executionClosureAcknowledged: true,
      sandboxQualification,
      assertion: "private-action-output",
    })),
  };
  const diagnostic =
    JSON.stringify({
      phase: "enrollment-safe-counters",
      extra: "private-diagnostic",
    }) + "\n";
  const shape =
    JSON.stringify({
      phase: "actual-cli-request-shape",
      extra: "private-request",
    }) + "\n";
  const proof = JSON.stringify(value) + "\n";
  const native = { ...value, rrAcceptance: false, rrReceipts: [] };
  const nativeProof = JSON.stringify(native) + "\n";
  const nativeSafe = joinedNativeProviderReceipt(diagnostic + nativeProof, expected);
  assert.equal(nativeSafe.rrAcceptance, false);
  assert.deepEqual(nativeSafe.rrReceipts, []);
  assert.equal(nativeSafe.providers.length, 6);
  assert.equal(JSON.stringify(nativeSafe).includes("private-"), false);
  assert.throws(() => joinedProviderReceipt(nativeProof, expected), /joined-proof-invalid/);
  assert.throws(() => joinedNativeProviderReceipt(proof, expected), /joined-proof-invalid/);
  for (const patch of [
    { rrReceipts: [value.rrReceipts[0]] },
    { nativeHead: "0".repeat(40) },
    { gatewayBaseHead: "0".repeat(40) },
    { nativeBinarySHA256: "0".repeat(64) },
    { sourceHashes: null },
    { providers: native.providers.slice(0, 5) },
    { actualPostgreSQL: false },
    { controlledTextAndFunctionToolRoundTrip: false },
    { nativeAccountInfoObservedAtAndProvenance: false },
    { dynamicOpenRouterAuthoritativeRemoval: false },
    { grokRefresh: false },
    { canonicalErasure: false },
  ]) {
    assert.throws(
      () => joinedNativeProviderReceipt(JSON.stringify({ ...native, ...patch }), expected),
      /joined-proof-invalid/,
    );
  }
  const safe = joinedProviderReceipt(diagnostic + shape + proof, expected);
  assert.equal(safe.rrReceipts.length, 6);
  assert.equal(safe.rrReceipts[5]?.structuredOutputRequests, 2);
  for (const receipt of safe.rrReceipts) {
    assert.deepEqual(receipt.sandboxQualification, sandboxQualification);
  }
  assert.equal(JSON.stringify(safe).includes("private-"), false);
  for (let omitted = 0; omitted < value.rrReceipts.length; omitted++) {
    assert.throws(
      () =>
        joinedProviderReceipt(
          JSON.stringify({
            ...value,
            rrReceipts: value.rrReceipts.map((receipt, index) =>
              index === omitted ? { ...receipt, sandboxQualification: undefined } : receipt,
            ),
          }),
          expected,
        ),
      /joined-proof-invalid/,
    );
  }
  for (const patch of [
    { rrAcceptance: false },
    { nativeHead: "0".repeat(40) },
    { gatewayBaseHead: "0".repeat(40) },
    { sourceHashes: null },
    { liveProviderAccount: true },
    { inertReadProviderCalls: 1 },
    { providers: value.providers.slice(0, 5) },
    { rrReceipts: value.rrReceipts.slice(0, 5) },
    { rrReceipts: [...value.rrReceipts.slice(0, 5), value.rrReceipts[0]] },
  ]) {
    assert.throws(
      () => joinedProviderReceipt(JSON.stringify({ ...value, ...patch }), expected),
      /joined-proof-invalid/,
    );
  }
  for (const patch of [
    { model: "unqualified-model" },
    { actionRef: "0".repeat(40) },
    { actionArchiveSHA256: "0".repeat(64) },
    { codexBinarySHA256: "0".repeat(64) },
    { codexVersion: "0.164.0" },
    { providerEntries: 1 },
    { streamCompletions: 1 },
    { structuredOutputRequests: 0 },
    { returnedFunctionTools: 0 },
    { returnedCustomTools: 0 },
    { declaredFunctionTools: 129 },
    { executionClosureAcknowledged: false },
    { reasoningOmitted: false },
    { sandboxQualification: { ...sandboxQualification, childExecuted: false } },
    { sandboxQualification: { ...sandboxQualification, workspaceWriteDenied: false } },
    { sandboxQualification: { ...sandboxQualification, loopbackTCPDenied: false } },
    { sandboxQualification: { ...sandboxQualification, diagnostic: "private-output" } },
  ]) {
    assert.throws(
      () =>
        joinedProviderReceipt(
          JSON.stringify({
            ...value,
            rrReceipts: value.rrReceipts.map((receipt, index) =>
              index === 5 ? { ...receipt, ...patch } : receipt,
            ),
          }),
          expected,
        ),
      /joined-proof-invalid/,
    );
  }
  for (const raw of [
    proof + proof,
    proof + shape,
    diagnostic,
    "private-plaintext\n" + proof,
    JSON.stringify({ phase: "unapproved-phase" }) + "\n" + proof,
    " ".repeat(131_073),
  ]) {
    assert.throws(() => joinedProviderReceipt(raw, expected), /joined-proof-invalid/);
  }
  assert.deepEqual(
    joinedFailure(
      JSON.stringify({
        phase: "failed",
        at: "gemini-native-tool-roundtrip",
        frame: "native-provider-joined.ts:634:11",
        assertion: "private-provider-output",
      }),
    ),
    {
      code: "joined-driver-failed",
      at: "gemini-native-tool-roundtrip",
      frame: "native-provider-joined.ts:634:11",
    },
  );
});

void test("sandbox preflight failure exports only its fixed diagnostic code", () => {
  const failed = {
    phase: "failed",
    at: "kimi-native-tool-roundtrip",
    failureCode: "rr_provider_joined_failed_cli_sandbox_preflight_none",
    stderr: "private-child-output",
    assertion: "private-managed-requirement",
  };
  assert.deepEqual(joinedFailure(JSON.stringify(failed)), {
    code: "joined-driver-failed",
    at: "kimi-native-tool-roundtrip",
    failureCode: "rr_provider_joined_failed_cli_sandbox_preflight_none",
  });
  for (const reason of [
    "positive_controls",
    "child_spawn",
    "child_timeout",
    "child_output_limit",
    "policy_refused",
    "child_namespace_refused",
    "child_usage_exit",
    "child_panic_exit",
    "child_nonzero_exit",
    "proof",
    "postconditions",
    "cleanup",
  ]) {
    const failureCode = "rr_provider_joined_failed_cli_sandbox_preflight_" + reason + "_none";
    assert.deepEqual(joinedFailure(JSON.stringify({ ...failed, failureCode })), {
      code: "joined-driver-failed",
      at: "kimi-native-tool-roundtrip",
      failureCode,
    });
  }
  for (const failureCode of [
    "private-child-error",
    "rr_provider_joined_failed_cli_sandbox_preflight_private_child_error_none",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_private",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_none\n",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_none\r",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_none\nprivate",
  ]) {
    assert.deepEqual(joinedFailure(JSON.stringify({ ...failed, failureCode })), {
      code: "joined-driver-failed",
      at: "kimi-native-tool-roundtrip",
    });
  }
});
