/** The only dynamic loader for this disposable cross-repository fixture.
 * Fixed entrypoints are admitted after the complete installed SDK bytes
 * match the SHA256-qualified archive. No submitted module name is accepted. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as c from "@agent-teams/account-gateway/contracts";
import type * as SDK from "@agent-teams/account-gateway/http";

// Structural consumer ports keep this Gateway fixture independent of a sibling
// checkout at compile time. The implementations are imported from its frozen
// RR source and their exact digests are recorded in the joined receipt.
type RRProfile = {
  id: string;
  availability: c.ConnectionProfileV3["availability"];
  connection?: {
    provider: string;
    nativeMethods?: Pick<
      c.ConnectionMethodV3,
      "methodId" | "revision" | "configurationGeneration" | "create" | "reconnect" | "availability"
    >[];
  };
};
type RROperation = {
  nonce: string;
  state: c.Operation["state"];
  cleanup: "unresolved";
  native?: { connection: c.ConnectionBinding; credential?: c.CredentialAttestation };
};
type RRResult<T> = { status: "ok"; value: T } | { status: "unavailable" };
type RRNativeClient = Pick<
  SDK.ManagementClient,
  | "beginConnection"
  | "reconnectConnection"
  | "submitConnection"
  | "pollConnection"
  | "readConnection"
>;
type RRAdapterInput = {
  authorize(context: string): Promise<string>;
  owner(owner: string): string;
  operationId(owner: string, nonce: string): string;
  client(context: string, owner: string, onEnter?: () => Promise<void>): RRNativeClient;
  reauthorize(context: string, owner: string): Promise<void>;
  profiles(): Promise<RRProfile[]>;
  reconnectTarget(
    context: string,
    owner: string,
    intent: RRConnectionIntent,
  ): Promise<{
    accountRef: string;
    profileId: string;
    metadataRevision: number;
    assertCurrent(): Promise<void>;
  }>;
  project(
    context: string,
    owner: string,
    nonce: string,
    operation: c.Operation,
  ): Promise<RROperation>;
  failure(): RRResult<never>;
};
type RRConnectionIntent = {
  nonce: string;
  connection: c.ConnectionBinding;
  label?: string;
  existing?: { connectionId: string; gatewayRevision: number; mirrorRevision: number };
};
type RRAdapter = {
  begin(
    context: string,
    intent: RRConnectionIntent,
    fields: Record<string, string>,
  ): Promise<
    RRResult<{
      operation: RROperation;
      authorizationURL?: string;
      deviceAuthorization?: { intervalSeconds: number };
    }>
  >;
  continue(
    context: string,
    nonce: string,
    fields?: Record<string, string>,
  ): Promise<RRResult<RROperation>>;
  read(context: string, nonce: string): Promise<RRResult<RROperation>>;
};
type JoinedReviewInput = {
  origin: string;
  token: string;
  accountRef: string;
  profileId: string;
  model: string;
  reviewProof?: { reasoningEffort: "medium"; maxOutputTokens: 8192 };
  limits: {
    requests: number;
    concurrency: number;
    requestBytes: number;
    outputBytes: number;
    tokens: number;
  };
};
type JoinedReviewReceipt = Readonly<{
  profileId: string;
  providerEntries: number;
  streamCompletions: number;
  structuredOutputRequests: number;
  executionClosureAcknowledged: boolean;
  reasoningOmitted: boolean;
  reasoningEffort?: "medium";
  reasoningRequests?: number;
  reasoningContinuations?: number;
  sandboxQualification?: { contract: string; childExecuted: boolean };
}>;

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonicalSchema(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalSchema).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalSchema(item))
        .join(",") +
      "}"
    );
  }
  const encoded = JSON.stringify(value);
  assert.equal(typeof encoded, "string");
  return encoded.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
async function qualifiedReviewSchemaDigest() {
  const archive = process.env.RR_PROVIDER_JOINED_ACTION_ARCHIVE;
  const work = process.env.RR_PROVIDER_JOINED_WORK_ROOT;
  assert.ok(archive && work && isAbsolute(archive) && isAbsolute(work));
  assert.equal(
    digest(await readFile(archive)),
    "42e8d844bd451655ff171dc4093a872fc471675c90b3997697261ba4153807b4",
  );
  const source = await mkdtemp(join(work, "joined-action-schema-"));
  try {
    execFileSync("tar", ["-xf", archive, "-C", source], { timeout: 5000 });
    const schemaPath = join(source, "src/providers/review-output.ts");
    const action = (await import(pathToFileURL(schemaPath).href)) as {
      buildReviewFindingsSchema(): unknown;
    };
    return digest(Buffer.from(canonicalSchema(action.buildReviewFindingsSchema())));
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}
export async function loadQualifiedConnectionConsumers(input: {
  archive: string;
  sdkRoot: string;
  sdkSHA256: string;
  rrRoot: string;
}) {
  const { archive, sdkRoot, sdkSHA256, rrRoot } = input;
  for (const path of [archive, sdkRoot, rrRoot]) assert.ok(isAbsolute(path));
  assert.match(sdkSHA256, /^[a-f0-9]{64}$/);
  assert.equal(digest(await readFile(archive)), sdkSHA256);
  const rrAdapterPath = join(rrRoot, "apps/web/src/server/native-connection-adapter.ts");
  const rrViewPath = join(rrRoot, "apps/web/src/server/native-connection-view.ts");
  const rrClientPath = join(rrRoot, "apps/web/src/server/native-connection-client.ts");
  const rrReviewPath = join(
    rrRoot,
    "scripts/review-investigation-paired-e2e/support/provider-subscriptions-joined.ts",
  );
  const rrRelayPath = join(rrRoot, "apps/api/src/review-run-gateway-relay.ts");
  const rrRequire = createRequire(rrAdapterPath);
  const rrSDKRoot = join(dirname(rrRequire.resolve("@agent-teams/account-gateway/http")), "../..");
  const packedFiles = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 5000 })
    .split("\n")
    .filter(Boolean);
  assert.ok(packedFiles.length > 10);
  for (const name of packedFiles) {
    assert.match(name, /^package\/[a-zA-Z0-9_.\/-]+$/);
    assert.equal(name.split("/").includes(".."), false);
    const expected = digest(
      execFileSync("tar", ["-xOzf", archive, name], { timeout: 5000, maxBuffer: 8 << 20 }),
    );
    for (const root of [sdkRoot, rrSDKRoot]) {
      assert.equal(
        digest(await readFile(join(root, name.slice(8)))),
        expected,
        "every installed SDK file, including its export map, matches its qualified archive",
      );
    }
  }
  // Execute the qualified consumer installation, including its locked runtime
  // dependencies. The unpacked archive directory is an additional byte check,
  // not an independently installed Node package.
  const sdkPath = join(rrSDKRoot, "dist/http/index.js");
  const sdk = (await import(pathToFileURL(sdkPath).href)) as typeof SDK;
  const { createNativeConnectionAdapter } = (await import(pathToFileURL(rrAdapterPath).href)) as {
    createNativeConnectionAdapter(input: RRAdapterInput): RRAdapter;
  };
  const { nativeConnectionProfileView } = (await import(pathToFileURL(rrViewPath).href)) as {
    nativeConnectionProfileView(input: c.ConnectionProfileV3): RRProfile;
  };
  const { createNativeConnectionManagementClient } = (await import(
    pathToFileURL(rrClientPath).href
  )) as {
    createNativeConnectionManagementClient(
      input: Omit<SDK.ManagementConfig, "timeoutMs">,
    ): SDK.ManagementClient;
  };
  // This is the existing real Action/Codex qualification, with its mandatory
  // pinned binary, archive, sandbox proof, tool roundtrip and execution closure.
  // Its SDK and relay paths are derived from the verified consumer checkout.
  async function reviewConsumer() {
    process.env.RR_PROVIDER_JOINED_SDK_HTTP = sdkPath;
    process.env.RR_PROVIDER_JOINED_RELAY_ADAPTER = rrRelayPath;
    return (await import(pathToFileURL(rrReviewPath).href)) as {
      acceptProvider(input: JoinedReviewInput): Promise<void>;
      joinedProviderReceipts: readonly JoinedReviewReceipt[];
    };
  }
  return {
    sdk,
    createNativeConnectionAdapter,
    nativeConnectionProfileView,
    createNativeConnectionManagementClient,
    reviewConsumer,
    reviewSchemaDigest: qualifiedReviewSchemaDigest,
    provenance: {
      sdkSHA256,
      sdkHTTPDigest: digest(await readFile(sdkPath)),
      rrAdapterDigest: digest(await readFile(rrAdapterPath)),
      rrViewDigest: digest(await readFile(rrViewPath)),
      rrClientDigest: digest(await readFile(rrClientPath)),
      rrReviewDigest: digest(await readFile(rrReviewPath)),
      rrRelayDigest: digest(await readFile(rrRelayPath)),
    },
  };
}
