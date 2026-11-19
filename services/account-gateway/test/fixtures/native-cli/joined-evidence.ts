// The joined drivers may hold assertions, OAuth data and client output in
// memory. Export only independently checked provenance and fixed proof fields.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ClientPins {
  clients: { id: string; version: string; binarySHA256: string }[];
}
export interface InstalledClients {
  pinsSHA256: string;
  clients: { id: string; executable: string }[];
}
export interface JoinedBuildReceipt {
  kind: string;
  nativeCommit: string;
  gatewayCommit: string;
  goVersion: string;
  sourceHashes: Record<string, string>;
  binaries?: Record<string, string> | null;
}
export function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type JoinedClient = "claude" | "codex";
export const joinedFiles = Object.freeze({
  claudeHarness: "services/account-gateway/test/native-claude-joined.ts",
  claudeFixture: "services/account-gateway/test/fixtures/native-claude-joined/main.go",
  codexHarness: "services/account-gateway/test/native-device-joined.ts",
  codexFixture: "services/account-gateway/test/fixtures/native-device-joined/main.go",
  providerHarness: "services/account-gateway/test/native-provider-joined.ts",
  providerFixture: "services/account-gateway/test/fixtures/native-provider-joined/main.go",
  sdkHTTP: "packages/account-gateway/dist/http/index.js",
});
export const digestFile = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export function joinedSourceHashes(repo: string): Record<string, string> {
  const hashes = Object.fromEntries(
    Object.entries(joinedFiles).map(([key, path]) => [key, digestFile(join(repo, path))]),
  );
  const tree = createHash("sha256");
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(repo, relative), { withFileTypes: true }).toSorted(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      if (entry.name === "node_modules") {
        continue;
      }
      const path = relative + "/" + entry.name;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        tree.update(path + "\0" + digestFile(join(repo, path)) + "\n");
      } else {
        throw new Error("joined-source-shape");
      }
    }
  };
  for (const relative of [
    "services/account-gateway/src",
    "packages/account-gateway/src",
    "packages/account-gateway/dist",
  ]) {
    walk(relative);
  }
  return { ...hashes, runtimeTree: tree.digest("hex") };
}
function check(value: unknown): asserts value {
  const accepted = Boolean(value);
  if (!accepted) {
    throw new Error("joined-proof-invalid");
  }
}
export function joinedReceipt(
  raw: string,
  client: JoinedClient,
  expected: {
    nativeCommit: string;
    gatewayCommit: string;
    binarySHA256: string;
    version: string;
    clientSHA256: string;
    sourceHashes: Record<string, string>;
  },
) {
  const lines = raw.trim().split(/\r?\n/);
  check(lines.length === 1 && lines[0].length <= 16_384);
  let decoded: unknown;
  try {
    decoded = JSON.parse(lines[0]) as unknown;
  } catch {
    throw new Error("joined-proof-invalid");
  }
  const r = record(decoded);
  const contract =
    client === "claude" ? "gateway-native-claude-joined/v1" : "gateway-native-device-joined/v1";
  check(
    r !== undefined &&
      r.phase === "completed" &&
      r.contract === contract &&
      r.nativeHead === expected.nativeCommit &&
      r.gatewayHead === expected.gatewayCommit &&
      r.nativeBinarySHA256 === expected.binarySHA256,
  );
  const sources = {
    harness: expected.sourceHashes[client + "Harness"],
    nativeFixture: expected.sourceHashes[client + "Fixture"],
    sdkHTTP: expected.sourceHashes.sdkHTTP,
  };
  const sourceHashes = record(r.sourceHashes);
  check(
    sourceHashes !== undefined &&
      Object.entries(sources).every(([key, value]) => sourceHashes[key] === value),
  );
  const a = record(r.actualCLI);
  check(
    a !== undefined &&
      a.id === client &&
      a.version === expected.version &&
      a.binarySHA256 === expected.clientSHA256 &&
      a.exitCode === 0 &&
      a.providerEntries === 1 &&
      a.sqlEffect === "completed" &&
      a.nativeClosed === true &&
      a.nativeAcknowledged === true &&
      a.transportOccupied === false &&
      a.usageRecorded === true &&
      a.executionClosed === true,
  );
  check(
    (client === "claude" ? a.terminalWaitedForDurability : a.terminalWithheldUntilDurable) === true,
  );
  const modelProof = client === "codex" ? { requestedModel: "gpt-5.4", usageModel: "gpt-5.4" } : {};
  if (client === "codex") {
    check(a.requestedModel === modelProof.requestedModel && a.usageModel === modelProof.usageModel);
  }
  return {
    contract,
    phase: "completed",
    nativeHead: expected.nativeCommit,
    gatewayHead: expected.gatewayCommit,
    nativeBinarySHA256: expected.binarySHA256,
    sourceHashes: sources,
    actualCLI: {
      id: client,
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
      ...modelProof,
    },
  };
}
export const joinedProviderProfiles = [
  ["kimi", "kimi-code-global-responses-apikey-v1", "k3-256k"],
  ["glm", "glm-coding-global-responses-apikey-v1", "glm-5.3-flash"],
  ["minimax", "minimax-mplan-global-responses-apikey-v1", "MiniMax-M3.1-Flash"],
  ["grok", "grok-subscription-responses-oauth-v1", "grok-4.7"],
  ["anthropic", "anthropic-messages-apikey-v1", "claude-sonnet-4-6"],
  ["gemini", "gemini-openai-chat-apikey-v1", "gemini-3.1-pro-preview"],
] as const;

/** Only a completed real child probe qualifies this test-only sandbox backend. */
export function joinedSandboxQualification(value: unknown) {
  const expected = {
    contract: "codex-read-only-sandbox/v1",
    backend: "bubblewrap",
    childExecuted: true,
    readSucceeded: true,
    workspaceWriteDenied: true,
    outsideWriteDenied: true,
    loopbackTCPDenied: true,
    noNewPrivileges: true,
  } as const;
  const observed = record(value);
  check(
    observed !== undefined &&
      Object.keys(observed).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([key, required]) => Object.hasOwn(observed, key) && observed[key] === required,
      ),
  );
  return expected;
}

/** This third case uses the real RR Action pin, independently of the two CLI lanes. */
export function joinedProviderReceipt(
  raw: string,
  expected: {
    nativeCommit: string;
    gatewayCommit: string;
    binarySHA256: string;
    sourceHashes: Record<string, string>;
    reviewRouterCommit: string;
    preloadSHA256: string;
    relayAdapterSHA256: string;
    actionRef: string;
    actionArchiveSHA256: string;
    clientSHA256: string;
    version: string;
  },
) {
  check(Buffer.byteLength(raw) <= 131_072);
  const lines = raw.trim().split(/\r?\n/);
  check(lines.length <= 64 && lines.every((line) => Buffer.byteLength(line) <= 32_768));
  let result: Record<string, unknown> | undefined;
  for (const line of lines) {
    check(result === undefined);
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(line) as unknown);
    } catch {
      throw new Error("joined-proof-invalid");
    }
    check(value !== undefined);
    if (value.phase === "completed") {
      result = value;
    } else {
      // Existing safe diagnostic events are deliberately not exported.
      check(
        value.phase === "enrollment-safe-counters" || value.phase === "actual-cli-request-shape",
      );
    }
  }
  const r = result;
  check(
    r !== undefined &&
      r.contract === "gateway-native-provider-joined/v1" &&
      r.nativeHead === expected.nativeCommit &&
      r.gatewayBaseHead === expected.gatewayCommit &&
      r.nativeBinarySHA256 === expected.binarySHA256 &&
      r.liveProviderAccount === false &&
      r.inertReadProviderCalls === 0,
  );
  const proofs = [
    "nativeHTTP",
    "gatewayFacadeAndSDK",
    "rrAcceptance",
    "actualPostgreSQL",
    "providerShapedFixture",
    "controlledTextAndFunctionToolRoundTrip",
    "officialAnthropicMessagesAndSchema",
    "officialGeminiChatSchemaAndAuthenticatedContinuation",
    "nativeAccountInfoObservedAtAndProvenance",
    "dynamicOpenRouterDiscoveryAndDispatch",
    "dynamicOpenRouterAuthoritativeRemoval",
    "dynamicOpenRouterQualifiedReasoning",
    "dynamicOpenRouterImmutableAnchor",
    "minimaxReasoningContentRoundTrip",
    "reconnectRetainsAccount",
    "canonicalErasure",
    "grokRefresh",
    "wrongOwnerDenied",
  ] as const;
  check(proofs.every((name) => r[name] === true));
  const sources = {
    harness: expected.sourceHashes.providerHarness,
    nativeFixture: expected.sourceHashes.providerFixture,
    sdkHTTP: expected.sourceHashes.sdkHTTP,
  };
  const observedSources = record(r.sourceHashes);
  check(
    observedSources !== undefined &&
      Object.entries(sources).every(([key, value]) => observedSources[key] === value),
  );
  const providers = joinedProviderProfiles.map(([provider]) => provider);
  check(JSON.stringify(r.providers) === JSON.stringify(providers));
  check(Array.isArray(r.rrReceipts) && r.rrReceipts.length === joinedProviderProfiles.length);
  const observedReceipts: unknown[] = r.rrReceipts;
  const rrReceipts = joinedProviderProfiles.map(([, profileId, model], index) => {
    const observed = record(observedReceipts[index]);
    check(
      observed !== undefined &&
        observed.profileId === profileId &&
        observed.model === model &&
        observed.actionRef === expected.actionRef &&
        observed.actionArchiveSHA256 === expected.actionArchiveSHA256 &&
        observed.codexBinarySHA256 === expected.clientSHA256 &&
        observed.codexVersion === expected.version &&
        observed.providerEntries === 2 &&
        observed.streamCompletions === 2 &&
        observed.structuredOutputRequests === 2 &&
        observed.executionClosureAcknowledged === true &&
        observed.reasoningOmitted === true &&
        observed.fastOmitted === true,
    );
    const functions = observed.declaredFunctionTools,
      custom = observed.declaredCustomTools;
    check(
      typeof functions === "number" &&
        Number.isSafeInteger(functions) &&
        functions > 0 &&
        functions <= 128 &&
        typeof custom === "number" &&
        Number.isSafeInteger(custom) &&
        custom >= 0 &&
        custom <= 128 &&
        observed.returnedFunctionTools === 1 &&
        observed.returnedCustomTools === (custom > 0 ? 1 : 0),
    );
    return {
      profileId,
      model,
      actionRef: expected.actionRef,
      actionArchiveSHA256: expected.actionArchiveSHA256,
      codexBinarySHA256: expected.clientSHA256,
      codexVersion: expected.version,
      providerEntries: 2,
      streamCompletions: 2,
      structuredOutputRequests: 2,
      declaredFunctionTools: functions,
      declaredCustomTools: custom,
      returnedFunctionTools: 1,
      returnedCustomTools: custom > 0 ? 1 : 0,
      reasoningOmitted: true,
      fastOmitted: true,
      executionClosureAcknowledged: true,
      sandboxQualification: joinedSandboxQualification(observed.sandboxQualification),
    };
  });
  return {
    phase: "completed",
    contract: "gateway-native-provider-joined/v1",
    nativeHead: expected.nativeCommit,
    gatewayBaseHead: expected.gatewayCommit,
    nativeBinarySHA256: expected.binarySHA256,
    sourceHashes: sources,
    reviewRouterCommit: expected.reviewRouterCommit,
    preloadSHA256: expected.preloadSHA256,
    relayAdapterSHA256: expected.relayAdapterSHA256,
    providers,
    rrReceipts,
    liveProviderAccount: false,
    inertReadProviderCalls: 0,
    ...Object.fromEntries(proofs.map((name) => [name, true])),
  };
}

export function joinedFailure(raw: string) {
  const phases = new Set([
    "guard",
    "pinned-client-and-network",
    "native-binary-input",
    "native-build-provenance",
    "native-clean-build-provenance",
    "gateway-source-provenance",
    "gateway-scratch",
    "native-start",
    "kernel-database-guard",
    "kernel-migrations",
    "fresh-browser-handoff",
    "owner-and-method-boundary",
    "authorized-native-custody-and-descriptor",
    "missing-cached-limits",
    "actual-messages-dispatch-produces-observation",
    "real-cli-public-authority",
    "terminal-withheld-before-real-usage-and-ack",
    "real-durable-terminal-usage-and-physical-closure",
    "real-execution-cleanup",
    "passive-cached-limits",
    "native-close",
    "fresh-device-handoff",
    "owner-boundary",
    "pending-provider-poll",
    "duplicate-and-readback-no-replay",
    "cached-native-account-limits",
    "actual-codex-cli-through-real-authority",
    "actual-codex-cli-cleanup",
    "gateway-control-composition",
    "gateway-native-composition",
    "safe-source-capabilities",
    "openrouter-dynamic-enrollment",
    "openrouter-dynamic-real-native-dispatch",
    "openrouter-dynamic-authoritative-removal",
    "grok-source-refresh",
    "canonical-generation-and-execution-cleanup",
    ...joinedProviderProfiles.flatMap(([provider]) =>
      [
        "protected-enrollment",
        "inert-reads",
        "unsupported-settings-zero-entry",
        "native-tool-roundtrip",
        "read-only-quota-collector",
        "reconnect-and-canonical-erasure",
      ].map((step) => provider + "-" + step),
    ),
  ]);
  let at = "driver",
    frame: string | undefined,
    failureCode: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.length > 16_384) {
      continue;
    }
    try {
      const value = record(JSON.parse(line) as unknown);
      if (value?.phase !== "failed") {
        continue;
      }
      if (typeof value.at === "string" && phases.has(value.at)) {
        at = value.at;
      }
      if (
        typeof value.frame === "string" &&
        /^native-(claude|device|provider)-joined\.ts:[0-9]{1,6}:[0-9]{1,6}$/.test(value.frame)
      ) {
        frame = value.frame;
      }
      if (
        typeof value.failureCode === "string" &&
        value.failureCode === value.failureCode.trim() &&
        /^rr_provider_joined_failed_cli_sandbox_preflight_(?:(?:positive_controls|child_spawn|child_timeout|child_output_limit|policy_refused|child_namespace_refused|child_usage_exit|child_panic_exit|child_nonzero_exit|proof|postconditions|cleanup)_)?none$/.test(
          value.failureCode,
        )
      ) {
        failureCode = value.failureCode;
      }
    } catch {
      /* Never reflect arbitrary child output. */
    }
  }
  return {
    code: "joined-driver-failed",
    at,
    ...(isNonemptyString(frame) ? { frame } : {}),
    ...(isNonemptyString(failureCode) ? { failureCode } : {}),
  };
}
