import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  joinedFailure,
  joinedReceipt,
  joinedProviderProfiles,
  joinedProviderReceipt,
  joinedSandboxQualification,
} from "./joined-evidence.ts";
import { CommandFailure, command } from "./joined-command.ts";
import { startWorkerHeartbeat } from "./worker-heartbeat.ts";

const json = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join("\n");

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

void test("worker renewal is nonoverlapping and stop drains the owned in-flight heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const stop = startWorkerHeartbeat(() => {
    calls++;
    return calls === 8 ? pending : Promise.resolve();
  });
  t.mock.timers.tick(4999);
  assert.equal(calls, 0);
  // Keep renewing through 35 seconds, beyond the original 30-second lease.
  for (let tick = 0; tick < 7; tick++) {
    t.mock.timers.tick(tick === 0 ? 1 : 5000);
    await Promise.resolve();
    assert.equal(calls, tick + 1);
  }
  t.mock.timers.tick(5000);
  assert.equal(calls, 8);
  t.mock.timers.tick(15_000);
  assert.equal(calls, 8);
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
    return stopped;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  t.mock.timers.tick(30_000);
  assert.equal(calls, 8);
  await stop();
});

void test("failed worker renewal cannot produce a successful stop or retry an expired lease", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const stop = startWorkerHeartbeat(async () => {
    calls++;
    throw new Error("private-database-error");
  });
  t.mock.timers.tick(5000);
  await assert.rejects(stop(), { message: "provider-worker-heartbeat-failed" });
  t.mock.timers.tick(30_000);
  assert.equal(calls, 1);
  await assert.rejects(stop(), { message: "provider-worker-heartbeat-failed" });
});

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
    await assert.rejects(runChild("overflow"), (error: unknown) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.status.outputLimit, true);
      assert.deepEqual(joinedFailure(error.output, error).command?.startup, {
        reason: "output-limit",
      });
      return true;
    });
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
        assert.equal(error.stdout, raw);
        assert.deepEqual(error.status, {
          exitCode: 1,
          signal: null,
          timedOut: false,
          outputLimit: false,
        });
        const sanitized = joinedFailure(error.output);
        assert.deepEqual(sanitized, {
          code: "joined-driver-failed",
          at: "real-execution-cleanup",
          frame: "native-device-joined.ts:42:9",
        });
        assert.equal(JSON.stringify(sanitized).includes("SECRET"), false);
        const withStatus = joinedFailure(error.output, error);
        assert.deepEqual(withStatus.command, error.status);
        assert.equal(JSON.stringify(withStatus).includes("SECRET"), false);
        return true;
      });
    },
  );
  await t.test(
    "early compiler spawn failure keeps closed status without any private path",
    async () => {
      const compiler =
        "/PRIVATE_SENTINEL/review-router-source/node_modules/.pnpm/@esbuild+linux-x64@0.28.1/node_modules/@esbuild/linux-x64/bin/esbuild";
      for (const state of ["was stopped", "is no longer running"]) {
        for (const errno of ["EACCES", "EPERM", "ENOENT", "ENOEXEC"]) {
          const stderr = `Error: The service ${state}: spawn ${compiler} ${errno}\n`;
          await assert.rejects(
            runChild("failure", "PRIVATE_STDOUT\n", stderr),
            (error: unknown) => {
              assert.ok(error instanceof CommandFailure);
              const safeFailure = joinedFailure(error.output, error);
              assert.deepEqual(safeFailure, {
                code: "joined-driver-failed",
                at: "driver",
                command: {
                  exitCode: 1,
                  signal: null,
                  timedOut: false,
                  outputLimit: false,
                  startup: { reason: "esbuild-spawn", errno },
                },
              });
              assert.equal(JSON.stringify(safeFailure).includes("PRIVATE"), false);
              return true;
            },
          );
        }
      }
      const known = `Error: The service was stopped: spawn ${compiler} EACCES\n`;
      for (const [stdout, stderr] of [
        [known, "PRIVATE_STDERR\n"],
        ["", known.replace("@0.28.1/", "@0.28.2/")],
        ["", known.replace(" EACCES", " PRIVATE_ERRNO")],
        ["", known.replace("Error:", "PRIVATE_PREFIX:")],
      ]) {
        await assert.rejects(runChild("failure", stdout, stderr), (error: unknown) => {
          assert.ok(error instanceof CommandFailure);
          const safeFailure = joinedFailure(error.output, error);
          assert.deepEqual(safeFailure.command?.startup, { reason: "unclassified" });
          assert.equal(JSON.stringify(safeFailure).includes("PRIVATE"), false);
          return true;
        });
      }
    },
  );
  await t.test("child timeout still terminates the detached command", async () => {
    await assert.rejects(runChild("wait", "", "", 100), (error: unknown) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.status.timedOut, true);
      assert.equal(error.status.signal, "SIGKILL");
      assert.deepEqual(joinedFailure(error.output, error).command?.startup, { reason: "timeout" });
      return true;
    });
  });
});

void test("provider evidence requires six real RR tool/schema receipts and removes private diagnostics", () => {
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
  const toolOutput = {
    phase: "actual-cli-tool-output-shape",
    profileId: joinedProviderProfiles[0][1],
    functionOutputs: 1,
    workspaceObserved: true,
    exitZeroObserved: true,
    unknownToolObserved: false,
    invalidArgumentsObserved: false,
    sandboxFailureObserved: false,
  };
  const toolShape = JSON.stringify(toolOutput) + "\n";
  const safe = joinedProviderReceipt(diagnostic + shape + toolShape + proof, expected);
  assert.equal(safe.rrReceipts.length, 6);
  assert.equal(safe.rrReceipts[5]?.structuredOutputRequests, 2);
  for (const receipt of safe.rrReceipts) {
    assert.deepEqual(receipt.sandboxQualification, sandboxQualification);
  }
  assert.equal(JSON.stringify(safe).includes("private-"), false);
  assert.equal(JSON.stringify(safe).includes("workspaceObserved"), false);
  for (const patch of [
    { profileId: "unqualified-profile" },
    { functionOutputs: 0 },
    { functionOutputs: 129 },
    { functionOutputs: 1.5 },
    { functionOutputs: "1" },
    { privateOutput: "private-tool-output" },
  ]) {
    assert.throws(
      () =>
        joinedProviderReceipt(JSON.stringify({ ...toolOutput, ...patch }) + "\n" + proof, expected),
      /joined-proof-invalid/,
    );
  }
  for (const key of [
    "workspaceObserved",
    "exitZeroObserved",
    "unknownToolObserved",
    "invalidArgumentsObserved",
    "sandboxFailureObserved",
  ]) {
    for (const invalid of [undefined, null, "private-diagnostic"]) {
      assert.throws(
        () =>
          joinedProviderReceipt(
            JSON.stringify({ ...toolOutput, [key]: invalid }) + "\n" + proof,
            expected,
          ),
        /joined-proof-invalid/,
      );
    }
  }
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
    proof + toolShape,
    toolShape,
    toolShape.repeat(64) + proof,
    diagnostic,
    "private-plaintext\n" + proof,
    JSON.stringify({ phase: "unapproved-phase" }) + "\n" + proof,
    JSON.stringify({ phase: "actual-cli-relay-error" }) + "\n" + proof,
    JSON.stringify({ phase: "actual-cli-sdk-error" }) + "\n" + proof,
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

void test("native failure diagnostics retain only closed SDK fields and known request phases", () => {
  const value = {
    phase: "failed",
    at: "anthropic-native-tool-continuation",
    frame: "native-provider-joined.ts:663:24",
    code: "qualification_failed",
    failureName: "GatewayError",
    failureCode: "safe_error",
    diagnosticCode: "upstream_failure",
    httpStatus: 502,
    message: "private-provider-message",
    body: "private-provider-body",
    traceRef: "private-reference",
    url: "https://private.invalid",
  };
  const safe = joinedFailure(JSON.stringify(value));
  assert.deepEqual(safe, {
    code: "joined-driver-failed",
    at: value.at,
    frame: value.frame,
    driverCode: "qualification_failed",
    failureName: "GatewayError",
    gatewayCode: "safe_error",
    diagnosticCode: "upstream_failure",
    httpStatus: 502,
  });
  assert.equal(JSON.stringify(safe).includes("private"), false);
  for (const [provider] of joinedProviderProfiles) {
    for (const stage of ["native-tool-request", "native-tool-continuation"]) {
      const at = provider + "-" + stage;
      assert.equal(joinedFailure(JSON.stringify({ ...value, at })).at, at);
    }
  }
  for (const at of [
    "unknown-native-tool-request",
    "anthropic-native-tool-request-private",
    "anthropic-native-tool-request\n",
  ]) {
    assert.equal(joinedFailure(JSON.stringify({ ...value, at })).at, "driver");
  }
  for (const [field, replacement, omitted] of [
    ["code", "private-driver-code", "driverCode"],
    ["failureName", "GatewayError\nprivate-class", "failureName"],
    ["failureCode", "safe_error\nprivate-code", "gatewayCode"],
    ["diagnosticCode", "upstream_failure\nprivate-code", "diagnosticCode"],
  ] as const) {
    const sanitized = joinedFailure(JSON.stringify({ ...value, [field]: replacement }));
    assert.equal(Object.hasOwn(sanitized, omitted), false);
    assert.equal(JSON.stringify(sanitized).includes("private"), false);
  }
  for (const httpStatus of [99, 600, 502.5, "502", null]) {
    assert.equal(
      Object.hasOwn(joinedFailure(JSON.stringify({ ...value, httpStatus })), "httpStatus"),
      false,
    );
  }
  const otherClass = joinedFailure(JSON.stringify({ ...value, failureName: "Error" }));
  for (const field of ["gatewayCode", "diagnosticCode", "httpStatus"]) {
    assert.equal(Object.hasOwn(otherClass, field), false);
  }
  const oversized = joinedFailure(JSON.stringify({ ...value, body: "private".repeat(3000) }));
  assert.deepEqual(oversized, { code: "joined-driver-failed", at: "driver" });
  const replaced = joinedFailure(
    JSON.stringify(value) + "\n" + JSON.stringify({ phase: "failed", at: "guard" }),
  );
  for (const field of [
    "driverCode",
    "failureName",
    "gatewayCode",
    "diagnosticCode",
    "httpStatus",
  ]) {
    assert.equal(Object.hasOwn(replaced, field), false);
  }
});

void test("RR failures export only fixed preflight and review diagnostic codes", () => {
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
    "proof_empty",
    "proof_size",
    "proof_json",
    "proof_shape",
    "proof_fields",
    "proof_contract",
    "proof_child_executed",
    "proof_read_succeeded",
    "proof_workspace_write_denied",
    "proof_outside_write_denied",
    "proof_loopback_tcp_denied",
    "proof_no_new_privileges",
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
  for (const phase of ["installed_action_real_cli_review", "tool_cycle_and_parser_proof"]) {
    for (const relayPhase of [
      "none",
      "ingress",
      "cli_model",
      "cli_stream",
      "cli_review_schema",
      "cli_reasoning",
      "cli_fast",
      "cli_tool_declarations",
      "cli_tool_output",
      "production_relay_adapter",
      "sdk_execution_request",
      "sdk_stream",
    ]) {
      const failureCode = "rr_provider_joined_failed_" + phase + "_" + relayPhase;
      assert.deepEqual(joinedFailure(JSON.stringify({ ...failed, failureCode })), {
        code: "joined-driver-failed",
        at: "kimi-native-tool-roundtrip",
        failureCode,
      });
    }
  }
  for (const failureCode of [
    "private-child-error",
    "rr_provider_joined_failed_cli_sandbox_preflight_private_child_error_none",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_private",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_none\n",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_none\r",
    "rr_provider_joined_failed_cli_sandbox_preflight_policy_refused_none\nprivate",
    "rr_provider_joined_failed_cli_sandbox_preflight_proof_private_none",
    "rr_provider_joined_failed_cli_sandbox_preflight_proof_read_succeeded_private",
    "rr_provider_joined_failed_cli_sandbox_preflight_proof_read_succeeded_none\n",
    "rr_provider_joined_failed_cli_sandbox_preflight_proof_read_succeeded_none\r",
    "rr_provider_joined_failed_cli_sandbox_preflight_proof_read_succeeded_none\nprivate",
    "rr_provider_joined_failed_private_phase_none",
    "rr_provider_joined_failed_installed_action_real_cli_review_private_relay",
    "rr_provider_joined_failed_installed_action_real_cli_review_sdk_stream_private",
    "rr_provider_joined_failed_installed_action_real_cli_review_sdk_stream\n",
    "rr_provider_joined_failed_installed_action_real_cli_review_sdk_stream\r",
    "rr_provider_joined_failed_installed_action_real_cli_review_sdk_stream\nprivate",
    "rr_provider_joined_failed_tool_cycle_and_parser_proof_private_relay",
    "rr_provider_joined_failed_tool_cycle_and_parser_proof_none_private",
    "rr_provider_joined_failed_tool_cycle_and_parser_proof_none\n",
    "rr_provider_joined_failed_tool_cycle_and_parser_proof_none\r",
    "rr_provider_joined_failed_tool_cycle_and_parser_proof_none\nprivate",
  ]) {
    assert.deepEqual(joinedFailure(JSON.stringify({ ...failed, failureCode })), {
      code: "joined-driver-failed",
      at: "kimi-native-tool-roundtrip",
    });
  }
});

void test("RR SDK and native counter events are retained only for the final failed provider", () => {
  const failed = { phase: "failed", at: "gemini-native-tool-roundtrip" };
  const sdk = {
    phase: "actual-cli-sdk-error",
    profileId: "gemini-openai-chat-apikey-v1",
    code: "safe_error",
    effect: "not_dispatched",
    diagnosticCode: "forbidden",
    httpStatus: 403,
  };
  const count = {
    dispatches: 1,
    exchanges: 0,
    refreshes: 0,
    quotaGets: 0,
    functionCalls: 1,
    customCalls: 1,
    functionOutputs: 0,
    customOutputs: 0,
    schemaRequests: 1,
    signatureChecks: 0,
  };
  const counters = {
    phase: "actual-cli-native-counters",
    provider: "gemini",
    counters: {
      kimi: count,
      glm: count,
      minimax: count,
      grok: count,
      anthropic: count,
      gemini: count,
      openrouter: count,
      unexpected: 0,
      openrouterModelGets: 2,
    },
  };
  const expected = {
    code: "joined-driver-failed",
    at: failed.at,
    sdk: {
      gatewayCode: "safe_error",
      effect: "not_dispatched",
      diagnosticCode: "forbidden",
      httpStatus: 403,
    },
    nativeCounters: { ...count, unexpected: 0 },
  };
  assert.deepEqual(
    joinedFailure(
      json(
        { ...sdk, profileId: "anthropic-messages-apikey-v1", diagnosticCode: "upstream_failure" },
        sdk,
        counters,
        {
          phase: "actual-cli-native-tool-shapes",
          provider: "gemini",
          shapes: "private-tool-output",
        },
        failed,
      ),
    ),
    expected,
  );
  for (const effect of [
    "not_dispatched",
    "dispatch_started",
    "response_started",
    "completed",
    "effect_unknown",
    "rejected_before_dispatch",
  ]) {
    assert.equal(joinedFailure(json({ ...sdk, effect }, failed)).sdk?.effect, effect);
  }
  assert.deepEqual(
    joinedFailure(
      json(
        { phase: sdk.phase, profileId: sdk.profileId, code: "transport", effect: "effect_unknown" },
        failed,
      ),
    ).sdk,
    { gatewayCode: "transport", effect: "effect_unknown" },
  );
  // Events after a failure, or before an earlier failure, cannot be grafted on.
  assert.deepEqual(joinedFailure(json(failed, sdk, counters)), {
    code: "joined-driver-failed",
    at: failed.at,
  });
  assert.deepEqual(joinedFailure(json(sdk, counters, failed, failed)), {
    code: "joined-driver-failed",
    at: failed.at,
  });
  assert.equal(
    joinedFailure(json(sdk, counters, { ...failed, at: "anthropic-native-tool-roundtrip" })).sdk,
    undefined,
  );
  assert.equal(
    joinedFailure(json(sdk, counters, { ...failed, at: "anthropic-native-tool-roundtrip" }))
      .nativeCounters,
    undefined,
  );
  for (const patch of [
    { profileId: "anthropic-messages-apikey-v1" },
    { profileId: sdk.profileId + "\n" },
    { code: "private-code" },
    { code: "safe_error\n" },
    { effect: "private-effect" },
    { effect: "not_dispatched\r" },
    { diagnosticCode: "private-diagnostic" },
    { diagnosticCode: "forbidden\n" },
    { diagnosticCode: null },
    { message: "private-message" },
    { traceRef: "private-reference" },
    ...[99, 600, 403.5, "403", null].map((httpStatus) => ({ httpStatus })),
  ]) {
    const safe = joinedFailure(json({ ...sdk, ...patch }, failed));
    assert.equal(safe.sdk, undefined);
    assert.equal(JSON.stringify(safe).includes("private"), false);
  }
  for (const candidate of [
    { ...counters, provider: "anthropic" },
    { ...counters, provider: "gemini\n" },
    { ...counters, traceRef: "private-reference" },
    { ...counters, counters: { ...counters.counters, private: "private-value" } },
    {
      ...counters,
      counters: { ...counters.counters, gemini: { ...count, private: "private-value" } },
    },
    { ...counters, counters: { ...counters.counters, unexpected: -1 } },
    { ...counters, counters: { ...counters.counters, openrouterModelGets: "private-value" } },
    ...[-1, 0.5, 1_000_001, "1", null].map((dispatches) => ({
      ...counters,
      counters: { ...counters.counters, gemini: { ...count, dispatches } },
    })),
  ]) {
    const safe = joinedFailure(json(candidate, failed));
    assert.equal(safe.nativeCounters, undefined);
    assert.equal(JSON.stringify(safe).includes("private"), false);
  }
  // A later malformed event for the same provider removes stale diagnostics.
  assert.equal(joinedFailure(json(sdk, { ...sdk, code: "private-code" }, failed)).sdk, undefined);
  assert.equal(
    joinedFailure(json(counters, { ...counters, counters: {} }, failed)).nativeCounters,
    undefined,
  );
  for (const at of ["gemini-native-tool-roundtrip\n", "private-phase", "guard"]) {
    const safe = joinedFailure(json(sdk, counters, { ...failed, at }));
    assert.equal(safe.sdk, undefined);
    assert.equal(safe.nativeCounters, undefined);
  }
});
