/** The only dynamic loader for this disposable cross-repository fixture.
 * Fixed entrypoints are admitted after the complete installed SDK bytes
 * match the SHA256-qualified archive. No submitted module name is accepted. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
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
  native?: {
    connection: c.ConnectionBinding;
    method: { methodId: string; interaction: { kind: string } };
    credential?: c.CredentialAttestation;
  };
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
type JoinedDispatchTrace = Readonly<{
  runOperationId: string;
  policySubjectRef: string;
  invocationRef: string;
  attemptRef: string;
  executionRef: string;
  requestRef: string;
  accountRef: string;
  profileId: string;
  modelId: string;
  occurredAt: string;
  serviceTier: "default";
}>;
type JoinedReviewInput = {
  origin: string;
  token: string;
  accountRef: string;
  profileId: string;
  model: string;
  reviewProof?: { reasoningEffort: "medium"; maxOutputTokens: 8192 };
  beforeDispatch?: (trace: JoinedDispatchTrace) => Promise<void>;
  limits: {
    requests: number;
    concurrency: number;
    requestBytes: number;
    outputBytes: number;
    tokens: number;
  };
};
type ExtensionObserver = {
  beforeReview: () => Promise<Readonly<Record<string, unknown>>>;
  beforeDispatch: (trace: JoinedDispatchTrace) => Promise<void>;
  afterReview: () => Promise<Readonly<Record<string, unknown>>>;
  afterRetirement: () => Promise<Readonly<Record<string, unknown>>>;
};
type ExtensionConsumer = {
  submitSetup: (input: {
    profile: c.ConnectionProfileV3;
    selection: c.ConnectionBinding;
    begin: (submission: {
      intent: { connection: c.ConnectionBinding; label?: string };
      inputFields: Record<string, string>;
      interaction: string;
    }) => Promise<void>;
  }) => Promise<{
    formSubmitted: true;
    methodId: string;
    interaction: string;
    environment: "dom_integration";
  }>;
  createExtensionObserver: (input: {
    origin: string;
    managementToken: string;
    consumerToken: string;
    ownerRef: string;
    accountRef: string;
    profile: c.ConnectionProfileV3;
    modelId: string;
  }) => Promise<ExtensionObserver>;
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
const oldAccountInfoArchive = "agent-teams-account-gateway-0.1.0-native-imports-f2690a3c9cfd.tgz";
const oldAccountInfoArchiveSHA256 =
  "34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f";
const oldAccountInfoSourceCommit = "f2690a3c9cfd0cf61bfb7ca31b802d249105d751";
const oldAccountInfoEsbuildSHA256 =
  "0c6588b092a2c291a72bab90659f3c9e0e25e0fe59c9ac12b4dae4d945e5548c";
function canonicalSchema(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalSchema).join(",") + "]";
  }
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

async function qualifiedOldAccountInfoClient(
  rrRoot: string,
  sdkRoot: string,
  configuration: SDK.ManagementConfig,
) {
  const archive = join(rrRoot, "vendor/account-gateway", oldAccountInfoArchive);
  const archiveBytes = await readFile(archive);
  assert.equal(digest(archiveBytes), oldAccountInfoArchiveSHA256);
  const association = JSON.parse(
    await readFile(
      join(rrRoot, "vendor/account-gateway/native-account-info-sdk-provenance.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(association.archive, oldAccountInfoArchive);
  assert.equal(association.sha256, oldAccountInfoArchiveSHA256);
  assert.equal(association.sdkSourceRepository, "agent-teams-ai/account-gateway");
  assert.equal(association.sdkSourceCommit, oldAccountInfoSourceCommit);
  assert.equal(association.uncommittedSource, false);
  const workRoot = process.env.RR_PROVIDER_JOINED_WORK_ROOT;
  assert.ok(workRoot !== undefined && isAbsolute(workRoot));
  const work = await mkdtemp(join(workRoot, "joined-old-account-info-sdk-"));
  try {
    const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 5000 })
      .split("\n")
      .filter(Boolean);
    assert.equal(names.length, 50);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
      assert.match(name, /^package\/[a-zA-Z0-9_./-]+$/);
      assert.equal(name.split("/").includes(".."), false);
    }
    execFileSync("tar", ["-xzf", archive, "-C", work], { timeout: 5000 });
    const oldRoot = join(work, "package");
    for (const name of names) {
      const path = join(work, name);
      assert.equal(await realpath(path), path);
      const archived = execFileSync("tar", ["-xOzf", archive, name], {
        timeout: 5000,
        maxBuffer: 8 << 20,
      });
      assert.equal(digest(await readFile(path)), digest(archived));
      await chmod(path, 0o400);
    }
    const oldPackage = JSON.parse(await readFile(join(oldRoot, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(oldPackage.name, "@agent-teams/account-gateway");
    assert.deepEqual(oldPackage.dependencies, {
      "@get-modular/assembly": "0.2.0",
      "@get-modular/core": "0.2.0",
      zod: "4.6.7",
    });
    const sdkRequire = createRequire(join(sdkRoot, "package.json"));
    const zodMetadata = await realpath(sdkRequire.resolve("zod/package.json"));
    const zodRoot = dirname(zodMetadata);
    const zod = JSON.parse(await readFile(zodMetadata, "utf8")) as {
      name: string;
      version: string;
    };
    assert.equal(zod.name, "zod");
    assert.equal(zod.version, "4.6.7");
    const lock = await readFile(join(rrRoot, "pnpm-lock.yaml"));
    assert.ok(lock.toString("utf8").includes("\n  zod@4.6.7:"));
    const rrRequire = createRequire(join(rrRoot, "package.json"));
    const esbuildRequire = createRequire(rrRequire.resolve("esbuild/package.json"));
    const esbuild = esbuildRequire.resolve("@esbuild/linux-x64/bin/esbuild");
    assert.equal(digest(await readFile(esbuild)), oldAccountInfoEsbuildSHA256);
    const bundle = join(work, "old-account-info-sdk.mjs");
    const metadata = join(work, "old-account-info-sdk-meta.json");
    execFileSync(
      esbuild,
      [
        "--bundle",
        "--platform=node",
        "--target=node24",
        "--format=esm",
        "--tree-shaking=false",
        "--loader=js",
        "--outfile=" + bundle,
        "--metafile=" + metadata,
        "--alias:zod=" + sdkRequire.resolve("zod"),
        "--log-level=silent",
      ],
      {
        cwd: oldRoot,
        input:
          'export * as http from "./dist/http/index.js";\nexport * as contracts from "./dist/contracts/index.js";\n',
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const graph = JSON.parse(await readFile(metadata, "utf8")) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
    const sourceFiles: Record<string, string> = {};
    const dependencyFiles: Record<string, string> = {
      "package.json": digest(await readFile(zodMetadata)),
    };
    for (const name of Object.keys(graph.inputs)) {
      if (name === "<stdin>") {
        continue;
      }
      const absolute = resolvePath(oldRoot, name);
      assert.equal(await realpath(absolute), absolute);
      const source = relative(oldRoot, absolute);
      const dependency = relative(zodRoot, absolute);
      if (/^dist\/.+\.js$/.test(source)) {
        assert.ok(names.includes("package/" + source));
        sourceFiles[source] = digest(await readFile(absolute));
      } else {
        assert.ok(!dependency.startsWith("..") && !isAbsolute(dependency));
        dependencyFiles[dependency] = digest(await readFile(absolute));
      }
    }
    assert.ok(Object.hasOwn(sourceFiles, "dist/http/index.js"));
    assert.ok(Object.hasOwn(sourceFiles, "dist/features/facade-client/contracts/account-info.js"));
    for (const output of Object.values(graph.outputs)) {
      assert.ok(
        output.imports.every((entry) => entry.external === true && entry.path.startsWith("node:")),
        "old SDK runtime has no external package or current SDK fallback",
      );
    }
    const bundleSHA256 = digest(await readFile(bundle));
    await chmod(bundle, 0o400);
    const old = (await import(pathToFileURL(bundle).href)) as {
      http: {
        createManagementClient(
          input: SDK.ManagementConfig,
        ): Pick<SDK.ManagementClient, "readAccountInfo">;
      };
      contracts: {
        ACCOUNT_INFO_CONTRACT: string;
        accountInfoReadResponse: { parse(input: unknown): c.AccountInfoReadResponse };
      };
    };
    assert.equal(old.contracts.ACCOUNT_INFO_CONTRACT, "account-info/v1");
    assert.equal(Object.hasOwn(old.contracts, "ACCOUNT_INFO_V2_CONTRACT"), false);
    const client = old.http.createManagementClient(configuration);
    assert.equal(Object.hasOwn(client, "readAccountInfoV2"), false);
    assert.equal(typeof client.readAccountInfo, "function");
    assert.equal(digest(await readFile(bundle)), bundleSHA256);
    return {
      client,
      parse: (value: unknown) => old.contracts.accountInfoReadResponse.parse(value),
      build: {
        contract: "gateway-account-info-pre-v2-sdk-build/v1",
        sdkSourceCommit: oldAccountInfoSourceCommit,
        archive: oldAccountInfoArchive,
        archiveSHA256: oldAccountInfoArchiveSHA256,
        bundleSHA256,
        esbuildSHA256: oldAccountInfoEsbuildSHA256,
        oldSourceGraphSHA256: digest(Buffer.from(canonicalSchema(sourceFiles))),
        zodVersion: zod.version,
        dependencySHA256: digest(Buffer.from(canonicalSchema(dependencyFiles))),
        consumerLockfileSHA256: digest(lock),
        sourceFiles,
        dependencyFiles,
        oldV1Contract: true,
        v2MethodAbsent: true,
      },
      close: () => rm(work, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

async function qualifiedReviewSchema() {
  const archive = process.env.RR_PROVIDER_JOINED_ACTION_ARCHIVE;
  const work = process.env.RR_PROVIDER_JOINED_WORK_ROOT;
  assert.ok(archive !== undefined && work !== undefined && isAbsolute(archive) && isAbsolute(work));
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
    const schema = action.buildReviewFindingsSchema();
    assert.ok(schema !== null && typeof schema === "object" && !Array.isArray(schema));
    const encoded = Buffer.from(canonicalSchema(schema));
    assert.ok(encoded.length <= 64 << 10);
    return { schema, sha256: digest(encoded) };
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
  for (const path of [archive, sdkRoot, rrRoot]) {
    assert.ok(isAbsolute(path));
  }
  // Start the Node child with the shared RR JSX configuration. The web-only
  // include list does not cover the production workspace UI package in tsx.
  assert.equal(process.env.TSX_TSCONFIG_PATH, join(rrRoot, "tsconfig.base.json"));
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
  const rrExtensionPath = join(
    rrRoot,
    "scripts/review-investigation-paired-e2e/support/provider-subscriptions-extension.ts",
  );
  const rrRequire = createRequire(rrAdapterPath);
  const rrSDKRoot = join(dirname(rrRequire.resolve("@agent-teams/account-gateway/http")), "../..");
  const packedFiles = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 5000 })
    .split("\n")
    .filter(Boolean);
  assert.ok(packedFiles.length > 10);
  for (const name of packedFiles) {
    assert.match(name, /^package\/[a-zA-Z0-9_./-]+$/);
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
    createNativeConnectionAdapter: (input: RRAdapterInput) => RRAdapter;
  };
  const { nativeConnectionProfileView } = (await import(pathToFileURL(rrViewPath).href)) as {
    nativeConnectionProfileView: (input: c.ConnectionProfileV3) => RRProfile;
  };
  const { createNativeConnectionManagementClient } = (await import(
    pathToFileURL(rrClientPath).href
  )) as {
    createNativeConnectionManagementClient: (
      input: Omit<SDK.ManagementConfig, "timeoutMs">,
    ) => SDK.ManagementClient;
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
  async function extensionConsumer(): Promise<ExtensionConsumer> {
    return (await import(pathToFileURL(rrExtensionPath).href)) as ExtensionConsumer;
  }
  const extensionFiles = {
    rrSetupDigest: "apps/web/app/dashboard/native-connection-form.tsx",
    rrSetupDomainDigest: "apps/web/src/features/account-gateway/domain/native-connection.ts",
    rrModelsDigest: "apps/web/src/server/native-account-models.ts",
    rrLimitsDigest: "apps/web/src/server/account-limits-composition.ts",
    rrLimitsProjectionDigest:
      "packages/features/provider-accounts/src/account-limits/domain/account-limits.ts",
    rrUsageSourceDigest: "apps/api/src/provider-usage-gateway-source.ts",
    rrUsageProjectionDigest: "packages/features/provider-usage/src/domain/usage.ts",
    rrUsageReportDigest: "packages/features/provider-usage/src/application/report-usage.ts",
    rrUsageViewDigest: "apps/web/src/server/provider-usage-view-model.ts",
    rrExtensionSetupDigest:
      "scripts/review-investigation-paired-e2e/support/provider-subscriptions-extension-setup.ts",
    rrExtensionUsageDigest:
      "scripts/review-investigation-paired-e2e/support/provider-subscriptions-extension-usage.ts",
    rrDispatchTraceDigest:
      "scripts/review-investigation-paired-e2e/support/provider-subscriptions-dispatch-trace.ts",
    rrConsumerLockfileDigest: "pnpm-lock.yaml",
    rrWebCompilerDigest: "apps/web/tsconfig.json",
    rrBaseCompilerDigest: "tsconfig.base.json",
  };
  const extensionProvenance: Record<string, string> = Object.fromEntries(
    await Promise.all(
      Object.entries(extensionFiles).map(
        async ([name, relativePath]) =>
          [name, digest(await readFile(join(rrRoot, relativePath)))] as const,
      ),
    ),
  );
  return {
    sdk,
    createNativeConnectionAdapter,
    nativeConnectionProfileView,
    createNativeConnectionManagementClient,
    reviewConsumer,
    extensionConsumer,
    oldAccountInfoClient: (configuration: SDK.ManagementConfig) =>
      qualifiedOldAccountInfoClient(rrRoot, rrSDKRoot, configuration),
    reviewSchema: qualifiedReviewSchema,
    provenance: {
      sdkSHA256,
      sdkHTTPDigest: digest(await readFile(sdkPath)),
      rrAdapterDigest: digest(await readFile(rrAdapterPath)),
      rrViewDigest: digest(await readFile(rrViewPath)),
      rrClientDigest: digest(await readFile(rrClientPath)),
      rrReviewDigest: digest(await readFile(rrReviewPath)),
      rrRelayDigest: digest(await readFile(rrRelayPath)),
      rrExtensionDigest: digest(await readFile(rrExtensionPath)),
      ...extensionProvenance,
    },
  };
}
