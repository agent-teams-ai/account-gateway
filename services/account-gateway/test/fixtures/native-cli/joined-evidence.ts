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
  ]);
  let at = "driver",
    frame: string | undefined;
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
        /^native-(claude|device)-joined\.ts:[0-9]{1,6}:[0-9]{1,6}$/.test(value.frame)
      ) {
        frame = value.frame;
      }
    } catch {
      /* Never reflect arbitrary child output. */
    }
  }
  return { code: "joined-driver-failed", at, ...(isNonemptyString(frame) ? { frame } : {}) };
}
