/** Full source-inventory qualification through real Native private HTTP/PG,
 * Gateway PG/facade, the installed packed SDK and unchanged RR consumers.
 * Every inventory row is attempted; execution uses the pinned real Action and
 * Codex CLI. Unavailable source methods remain explicit qualification blockers. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { Pool } from "pg";
import * as c from "@agent-teams/account-gateway/contracts";
import { PostgresKernel } from "../src/postgres.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { PostgresUsageJournal } from "../src/usage.ts";
import { createFacade, cancelFacadeTransport } from "../src/facade.ts";
import type { FacadeOptions } from "../src/facade.ts";
import {
  composeServiceControl,
  composeServiceNative,
  loadNativeConnectionProfiles,
  composeServiceCachedLimits,
  composeServiceCleanupTurn,
} from "../src/service-assembly.ts";
import type { ServiceConfig } from "../src/service-config.ts";
import { startWorkerHeartbeat } from "./fixtures/native-cli/worker-heartbeat.ts";
import { loadQualifiedConnectionConsumers } from "./fixtures/native-connections-joined/consumers.ts";
import { prepareGatewayRollbackReader } from "./fixtures/native-connections-joined/rollback.ts";

const report = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value !== undefined && isAbsolute(value), name + " must be an absolute path");
  return value;
};
const servers: Server[] = [];
let frames: ReturnType<typeof createInterface> | undefined;
let pool: Pool | undefined;
let heartbeat: (() => Promise<void>) | undefined;
let rollback: Awaited<ReturnType<typeof prepareGatewayRollbackReader>> | undefined;
let phase = "guard";
type Completion = {
  action: "submit" | "poll";
  fields?: Record<string, string>;
  fromAuthorizationURL?: boolean;
};
type Row = {
  id: string;
  profileId: string;
  methodId: string;
  variant: string;
  fields: Record<string, string>;
  completion?: Completion[];
  reconnectFields?: Record<string, string>;
  reconnectCompletion?: Completion[];
  credentialKind: c.CredentialAttestation["credentialKind"];
  credentialPolicy: c.CredentialAttestation["credentialPolicy"];
  refreshPolicy: c.CredentialAttestation["refreshPolicy"];
  provider: string;
  model: string;
  executionFamily: string;
  execute: boolean;
  reviewProof?: { reasoningEffort: "medium"; maxOutputTokens: 8192 };
  blocker?: string;
};
type RowReceipt = {
  rowId: string;
  outcome: "passed" | "failed" | "blocked";
  enrolled: boolean;
  recovery: boolean;
  lifecycle: boolean;
  reconnect: "not_requested" | "passed" | "failed";
  review: "not_requested" | "passed" | "failed" | "not_run";
  erased: boolean;
  pendingRecovery?: boolean;
  slowSSOMilliseconds?: number;
  failure?: { at: string; error: string; code?: string; locations?: string[] };
};
type CredentialScanReceipt = Awaited<ReturnType<typeof assertCredentialsAbsent>>;
type ExtensionProof = {
  setup?: {
    formSubmitted: true;
    methodId: string;
    interaction: string;
    environment: "dom_integration";
  };
  beforeReview?: Readonly<Record<string, unknown>>;
  afterReview?: Readonly<Record<string, unknown>>;
  afterRetirement?: Readonly<Record<string, unknown>>;
  activeCredentialScan?: CredentialScanReceipt;
  retiredCredentialScan?: CredentialScanReceipt;
};
const extensionOracle = {
  rowId: "fixture-native-extension-responses-v1/fixture_browser_v1/same_consumer_build",
  profileId: "fixture-native-extension-responses-v1",
  providerId: "fixture-native-extension",
  methodId: "fixture_browser_v1",
  modelId: "fixture-review-model",
} as const;
const consumerBuildDigest = (provenance: Readonly<Record<string, string>>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(provenance).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
function safeFailure(error: unknown, at: string): NonNullable<RowReceipt["failure"]> {
  const raw =
    error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    at,
    error: error instanceof Error ? error.name : "failure",
    ...(typeof raw === "string" && /^[a-z_]{1,160}$/.test(raw) ? { code: raw } : {}),
    locations:
      error instanceof Error
        ? error.stack
            ?.split("\n")
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 3)
        : [],
  };
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}
async function measuredBytes(url: string, credential: string) {
  const response = await fetch(url, {
    headers: {
      authorization: "Bearer " + credential,
      "content-type": "application/json",
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 2_097_152);
  return bytes.byteLength;
}
async function assertCredentialsAbsent(database: Pool, sentinels: readonly string[]) {
  assert.equal(sentinels.length, 2);
  assert.equal(new Set(sentinels).size, 2);
  assert.ok(sentinels.every((value) => value.length >= 16 && value.length <= 1024));
  const tables = await database.query<{ table_schema: string; table_name: string }>(
    "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('ag_kernel','ag_management') AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
  );
  assert.ok(tables.rows.length > 0);
  let scannedRows = 0;
  for (const table of tables.rows) {
    assert.match(table.table_schema, /^[a-z][a-z0-9_]+$/);
    assert.match(table.table_name, /^[a-z][a-z0-9_]+$/);
    const snapshot = await database.query<{ encoded: string }>(
      `SELECT row_to_json(source_row)::text AS encoded FROM "${table.table_schema}"."${table.table_name}" AS source_row LIMIT 10001`,
    );
    assert.ok(snapshot.rows.length <= 10_000, "credential scan is bounded");
    for (const row of snapshot.rows) {
      assert.ok(Buffer.byteLength(row.encoded) <= 4 * 1024 * 1024);
      assert.equal(
        sentinels.some((sentinel) => row.encoded.includes(sentinel)),
        false,
        "provider credential must not enter Gateway durable rows",
      );
    }
    scannedRows += snapshot.rows.length;
  }
  return { absent: true as const, schemas: 2, tables: tables.rows.length, scannedRows };
}
async function main() {
  assert.equal(process.env.AG_NATIVE_CONNECTION_JOINED_ALLOW, "disposable_pg17_10");
  const fixture = JSON.parse(
    await readFile(required("AG_NATIVE_CONNECTION_JOINED_FIXTURE"), "utf8"),
  ) as {
    nativeOrigin: string;
    consumerId: string;
    managementCredential: string;
    executionCredential: string;
    cleanupCredential: string;
    callbackCredential: string;
    originRef: string;
    engineIncarnation: string;
    qualificationRef: string;
    profiles: string[];
    rows: Row[];
    exchangePath: string;
    private: Record<string, string>;
    batch: "standard" | "express" | "extensibility";
    expectedInventoryRows: number;
    expectedExtensionRows?: number;
  };
  assert.equal(fixture.expectedInventoryRows, 53);
  assert.ok(["standard", "express", "extensibility"].includes(fixture.batch));
  const isExtensibility = fixture.batch === "extensibility";
  assert.equal(fixture.rows.length, fixture.batch === "standard" ? 52 : 1);
  if (isExtensibility) {
    assert.equal(fixture.expectedExtensionRows, 1);
    const [extension] = fixture.rows;
    assert.equal(extension.id, extensionOracle.rowId);
    assert.equal(extension.profileId, extensionOracle.profileId);
    assert.equal(extension.provider, extensionOracle.providerId);
    assert.equal(extension.methodId, extensionOracle.methodId);
    assert.equal(extension.model, extensionOracle.modelId);
    assert.equal(extension.execute, true);
    assert.equal(extension.blocker, undefined);
  }
  assert.equal(new Set(fixture.rows.map((row) => row.id)).size, fixture.rows.length);
  assert.ok(isAbsolute(fixture.exchangePath));
  for (const row of fixture.rows) {
    assert.equal(row.id, `${row.profileId}/${row.methodId}/${row.variant}`);
  }
  const native = new URL(fixture.nativeOrigin);
  assert.equal(native.protocol, "http:");
  assert.equal(native.hostname, "127.0.0.1");
  assert.ok(native.port);
  assert.equal(native.username + native.password + native.search + native.hash, "");
  phase = "packed-sdk-provenance";
  const loadConsumers = () =>
    loadQualifiedConnectionConsumers({
      archive: required("AG_NATIVE_CONNECTION_JOINED_SDK_TGZ"),
      sdkRoot: required("AG_NATIVE_CONNECTION_JOINED_SDK_ROOT"),
      sdkSHA256: process.env.AG_NATIVE_CONNECTION_JOINED_SDK_SHA256 ?? "",
      rrRoot: required("RR_NATIVE_CONNECTION_JOINED_ROOT"),
    });
  const {
    sdk,
    createNativeConnectionAdapter,
    nativeConnectionProfileView,
    createNativeConnectionManagementClient,
    reviewConsumer,
    extensionConsumer,
    reviewSchema: loadReviewSchema,
    provenance,
  } = await loadConsumers();
  const consumerBuildDigestBefore = consumerBuildDigest(provenance);
  const extensionModule = isExtensibility ? await extensionConsumer() : undefined;
  const extensionProof: ExtensionProof | undefined = isExtensibility ? {} : undefined;
  const extensionSentinels = isExtensibility
    ? [fixture.private.extensionSentinelFirst, fixture.private.extensionSentinelReplacement]
    : [];
  phase = "gateway-postgres";
  const dsn = process.env.AG_NATIVE_CONNECTION_JOINED_KERNEL_DSN;
  assert.ok(dsn !== undefined && dsn.length > 0);
  const database = new URL(dsn);
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.username, "postgres");
  assert.equal(database.password, "");
  assert.equal(database.search, "?sslmode=disable");
  assert.ok(database.pathname.startsWith("/ag_kernel_test_connections_joined_"));
  pool = new Pool({
    connectionString: dsn,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  pool.on("error", () => {});
  const version = (
    await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version")
  ).rows[0];
  assert.match(version.version, /^17\.10(?:$| )/);
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')"))
      .rowCount,
    0,
  );
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((candidate) => /^\d{3}_.*\.sql$/.test(candidate))
    .toSorted()) {
    await pool.query(await readFile(new URL(name, migrations), "utf8"));
  }
  const kernel = new PostgresKernel(pool),
    secrets = new IntentSecrets(randomBytes(32), randomBytes(32));
  const store = new PostgresManagementStore(pool, secrets);
  phase = "old-gateway-reader-build";
  if (fixture.batch !== "express") {
    rollback = await prepareGatewayRollbackReader({
      readerRoot: required("AG_NATIVE_CONNECTION_JOINED_GATEWAY_READER_ROOT"),
      rrRoot: required("RR_NATIVE_CONNECTION_JOINED_ROOT"),
      workRoot: required("RR_PROVIDER_JOINED_WORK_ROOT"),
      output: required("GATEWAY_NATIVE_CONNECTION_JOINED_ARTIFACTS"),
      databaseURL: dsn,
    });
  }
  const kernelContext = { consumerId: fixture.consumerId },
    worker = randomUUID();
  await kernel.issuer(kernelContext);
  await kernel.heartbeat(kernelContext, worker);
  heartbeat = startWorkerHeartbeat(() => kernel.heartbeat(kernelContext, worker));
  const ownerRef = "joined-rr-owner",
    token = randomBytes(32).toString("base64url"),
    consumerToken = randomBytes(32).toString("base64url");
  const limits = {
    requests: 12,
    concurrency: 1,
    requestBytes: 1 << 20,
    outputBytes: 1 << 20,
    tokens: 16_384,
  };
  const cfg = {
    native: {
      origin: fixture.nativeOrigin,
      originRef: fixture.originRef,
      executable: "/unused",
      sha256: "0".repeat(64),
      bootstrapFile: "/unused",
      authorityDir: "/unused",
      uid: 65534,
      gid: 65534,
    },
    consumer: {
      consumerId: fixture.consumerId,
      managementCredential: fixture.managementCredential,
      callbackCredential: fixture.callbackCredential,
      executionCredential: fixture.executionCredential,
      cleanupCredential: fixture.cleanupCredential,
    },
    nativeConnections: {
      contract: "native-account-capabilities/v2",
      profiles: fixture.profiles.map((profileId) => ({
        profileId,
        limits,
        providerTokenUpperBound: limits.tokens,
      })),
    },
    bearers: [
      {
        role: "management",
        token,
        consumerId: fixture.consumerId,
        ownerScope: "consumer",
        profileIds: fixture.profiles,
        preparation: {
          accountRefs: [],
          subjectRef: "joined-provider-policy",
          policyRevision: 1,
          bindingRevision: 1,
          profileId: fixture.profiles[0],
          limits,
          maxRunMs: 60_000,
        },
      },
      {
        role: "consumer-control",
        token: consumerToken,
        consumerId: fixture.consumerId,
        profileIds: fixture.profiles,
        limits,
        maxRunMs: 60_000,
      },
    ],
  } satisfies Pick<ServiceConfig, "native" | "consumer" | "nativeConnections" | "bearers">;
  const snapshot = await loadNativeConnectionProfiles(cfg);
  assert.ok(snapshot);
  assert.equal(snapshot.enrollment.engineIncarnation, fixture.engineIncarnation);
  const control = composeServiceControl(cfg, kernel, store, secrets, worker, undefined, snapshot);
  const enrollment = {
    originRef: fixture.originRef,
    engineIncarnation: fixture.engineIncarnation,
    worker,
  };
  const usage = new PostgresUsageJournal(pool, randomBytes(32));
  const bridge = composeServiceNative(cfg, control, kernel, store, enrollment, usage);
  const callbackOrigin = await listen(bridge.authority.createServer());
  const facadeOptions = {
    kernel,
    store,
    management: control.management,
    bearers: control.bearers,
    profiles: control.catalog,
    enrollment,
    transport: bridge.transport,
    usage,
    ...composeServiceCachedLimits(control),
    intentHmacKey: randomBytes(32),
    lifecycle: { contract: c.LIFECYCLE_CAPABILITY_CONTRACT, writeGate: "enabled" },
  } satisfies FacadeOptions;
  const origin = await listen(createFacade(facadeOptions));
  frames = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const next = frames[Symbol.asyncIterator]();
  const { schema: reviewSchema, sha256: reviewSchemaSHA256 } = await loadReviewSchema();
  report({ phase: "ready", callbackOrigin, reviewSchemaSHA256, reviewSchema });
  const frame = await next.next();
  assert.equal(frame.done, false);
  assert.deepEqual(JSON.parse(frame.value), { phase: "continue" });
  async function handshake(expected: object) {
    const response = await next.next();
    assert.equal(response.done, false);
    assert.deepEqual(JSON.parse(response.value), expected);
  }
  // Use the exact production RR budget split, backed by the installed pack
  // verified above. No fixture-only timeout override masks its behavior.
  const client = createNativeConnectionManagementClient({ role: "management", origin, token });
  const lifecycle = sdk.createLifecycleV3Client({
    role: "management",
    origin,
    token,
    capability: c.LIFECYCLE_V3_CAPABILITY_CONTRACT,
    clientContract: c.LIFECYCLE_V3_CLIENT_CONTRACT,
  });
  let discovery = true,
    catalogReads = 0;
  let rawProfiles: readonly c.ConnectionProfileV3[] = [];
  const ownedAccounts = new Map<string, { accountRef: string; profileId: string }>();
  const profileViews = async () => {
    assert.equal(discovery, true, "recovery must not rediscover a method");
    catalogReads++;
    rawProfiles = (await client.getProviderConnectionCapabilitiesV3()).capabilities;
    return rawProfiles.map(nativeConnectionProfileView);
  };
  const createAdapter = () =>
    createNativeConnectionAdapter({
      authorize: async (context: string) => {
        assert.equal(context, "authorized");
        return ownerRef;
      },
      owner: (owner: string) => owner,
      operationId: (_owner: string, nonce: string) => "rr-joined-" + nonce,
      client: (context, owner, onEnter) => {
        assert.equal(context, "authorized");
        assert.equal(owner, ownerRef);
        const entered = async <T>(call: () => Promise<T>) => {
          await onEnter?.();
          try {
            return await call();
          } catch (error) {
            if (error instanceof sdk.GatewayError) {
              report({
                phase: "gateway-method-failed",
                code: error.diagnostic?.code,
                effect: error.effect,
              });
            }
            throw error;
          }
        };
        return {
          beginConnection: (request) => entered(() => client.beginConnection(request)),
          reconnectConnection: (account, request) =>
            entered(() => client.reconnectConnection(account, request)),
          submitConnection: (request) => entered(() => client.submitConnection(request)),
          pollConnection: (request) => entered(() => client.pollConnection(request)),
          readConnection: (operation) => client.readConnection(operation),
        };
      },
      reauthorize: async (context: string, owner: string) => {
        assert.equal(context, "authorized");
        assert.equal(owner, ownerRef);
      },
      profiles: profileViews,
      reconnectTarget: async (context, owner, intent) => {
        assert.equal(context, "authorized");
        assert.equal(owner, ownerRef);
        assert.ok(intent.existing);
        assert.equal(intent.existing.mirrorRevision, 1);
        const target = ownedAccounts.get(intent.existing.connectionId);
        assert.ok(target);
        assert.equal(target.profileId, intent.connection.profileId);
        const expected = intent.existing.gatewayRevision;
        const assertCurrent = async () => {
          const account = await client.get(target.accountRef);
          assert.equal(account.ownerRef, ownerRef);
          assert.equal(account.metadataRevision, expected);
        };
        await assertCurrent();
        return { ...target, metadataRevision: expected, assertCurrent };
      },
      project: async (_context: string, _owner: string, nonce: string, operation: c.Operation) => ({
        nonce,
        state: operation.state,
        cleanup: "unresolved" as const,
      }),
      failure: () => ({ status: "unavailable" as const }),
    });
  let adapter = createAdapter();
  phase = "native-discovery-through-rr";
  const profiles = await profileViews();
  assert.equal(profiles.length, fixture.profiles.length);
  const discoveredProviders = profiles.map((profile) => {
    assert.ok(profile.connection);
    return {
      profileId: profile.id,
      providerId: profile.connection.provider,
      methodIds: profile.connection.nativeMethods?.map((method) => method.methodId) ?? [],
    };
  });
  if (fixture.batch === "standard") {
    const discovered = profiles.find((profile) => profile.id === "deepseek-responses-apikey-v1");
    assert.equal(discovered?.connection?.provider, "deepseek");
    assert.ok(
      discovered.connection.nativeMethods?.some(
        (method) => method.methodId === "api_key" && method.create,
      ) === true,
    );
  }
  const nativeCatalogBytes = await measuredBytes(
    fixture.nativeOrigin + "/private/native/v2/account-capabilities",
    fixture.managementCredential,
  );
  const publicCatalogBytes = await measuredBytes(
    origin + "/v3/provider-connection-capabilities",
    token,
  );
  report({
    phase: "catalog-bytes",
    batch: fixture.batch,
    profiles: profiles.length,
    nativeCatalogBytes,
    publicCatalogBytes,
    reviewSchemaSHA256,
  });
  // These are the production cleanup orchestration and native cancellation
  // paths, including real CLI execution transports and replaced generations.
  const cleanupTurn = composeServiceCleanupTurn(kernel, kernelContext, worker, async (claim) => {
    if (claim.scope.kind === "generation") {
      assert.equal(await control.management.cleanupClaim(kernelContext, claim), "erased");
    } else {
      for (const item of claim.scope.transports) {
        assert.ok(item.native && typeof item.token === "string" && item.token.length > 0);
        assert.equal(item.native.originRef, enrollment.originRef);
        assert.equal(item.native.engineIncarnation, enrollment.engineIncarnation);
        await cancelFacadeTransport(
          facadeOptions,
          kernelContext,
          { ...item, native: item.native, token: item.token },
          claim,
        );
      }
      await kernel.settleCleanup(kernelContext, claim.cleanupRef, worker, claim.token, true);
    }
    return true;
  });
  async function drainCleanup() {
    let idle = 0;
    for (let turns = 0; turns < 64; turns++) {
      const acquired = await cleanupTurn();
      idle = acquired ? 0 : idle + 1;
      if (idle === 2) {
        return;
      }
    }
    throw new Error("joined_cleanup_did_not_drain");
  }
  async function nativeCompletion(
    row: Row,
    step: Completion,
    authorizationURL: string | undefined,
  ) {
    if (step.fromAuthorizationURL !== true) {
      return step.fields;
    }
    assert.equal(step.action, "submit");
    assert.ok(authorizationURL !== undefined && authorizationURL.length > 0);
    await writeFile(fixture.exchangePath, JSON.stringify({ rowId: row.id, authorizationURL }), {
      mode: 0o600,
    });
    const info = await lstat(fixture.exchangePath);
    assert.ok(info.isFile() && (info.mode & 0o777) === 0o600 && info.size <= 16_384);
    report({ phase: "authorize", rowId: row.id });
    await handshake({ phase: "authorization-ready", rowId: row.id });
    const returned: unknown = JSON.parse(await readFile(fixture.exchangePath, "utf8"));
    await rm(fixture.exchangePath);
    assert.ok(returned !== null && typeof returned === "object" && !Array.isArray(returned));
    assert.ok("rowId" in returned && "fields" in returned);
    assert.equal(returned.rowId, row.id);
    const fields = returned.fields;
    assert.ok(fields !== null && typeof fields === "object" && !Array.isArray(fields));
    assert.ok(Object.values(fields).every((value) => typeof value === "string"));
    return fields as Record<string, string>;
  }
  const receipts: RowReceipt[] = [];
  const reviews: unknown[] = [];
  let reviewEnvironmentBlocker: NonNullable<RowReceipt["failure"]> | undefined;
  let reviewSource: Awaited<ReturnType<typeof reviewConsumer>> | undefined;
  const rows = fixture.rows.toSorted(
    (a, b) => Number(Boolean(a.blocker)) - Number(Boolean(b.blocker)),
  );
  for (const row of rows) {
    const receipt: RowReceipt = {
      rowId: row.id,
      outcome: "failed",
      enrolled: false,
      recovery: false,
      lifecycle: false,
      reconnect:
        row.reconnectFields !== undefined || row.reconnectCompletion !== undefined
          ? "failed"
          : "not_requested",
      review: row.execute ? "not_run" : "not_requested",
      erased: false,
    };
    receipts.push(receipt);
    let accountRef: string | undefined;
    let retired = false;
    let extensionObserver:
      | Awaited<ReturnType<NonNullable<typeof extensionModule>["createExtensionObserver"]>>
      | undefined;
    try {
      phase = "row-selection";
      report({ phase: "case", rowId: row.id });
      await handshake({ phase: "case-ready", rowId: row.id });
      discovery = true;
      const profile = profiles.find((candidate) => candidate.id === row.profileId);
      assert.ok(profile, "every source inventory row remains present in native discovery");
      assert.equal(profile.connection?.provider, row.provider);
      const method = profile.connection.nativeMethods?.find(
        (candidate) => candidate.methodId === row.methodId,
      );
      assert.ok(method);
      const selection = {
        profileId: row.profileId,
        methodId: row.methodId,
        methodRevision: method.revision,
        configurationGeneration: method.configurationGeneration,
      };
      const nonce = randomUUID(),
        started = Date.now();
      phase = "rr-enrollment";
      const beginning: { result?: Awaited<ReturnType<typeof adapter.begin>> } = {};
      const rawProfile = rawProfiles.find((candidate) => candidate.profileId === row.profileId);
      if (extensionModule) {
        assert.ok(rawProfile);
        assert.ok(extensionProof);
        let submissions = 0;
        extensionProof.setup = await extensionModule.submitSetup({
          profile: rawProfile,
          selection,
          begin: async (submission) => {
            submissions++;
            assert.equal(submissions, 1);
            assert.deepEqual(submission.intent.connection, selection);
            assert.equal(submission.interaction, "browser");
            assert.deepEqual(submission.inputFields, row.fields);
            beginning.result = await adapter.begin(
              "authorized",
              { nonce, ...submission.intent },
              submission.inputFields,
            );
          },
        });
        assert.equal(extensionProof.setup.formSubmitted, true);
        assert.equal(extensionProof.setup.methodId, row.methodId);
        assert.equal(extensionProof.setup.interaction, "browser");
        assert.equal(submissions, 1);
      } else {
        beginning.result = await adapter.begin(
          "authorized",
          { nonce, connection: selection, label: "Joined " + row.methodId },
          row.fields,
        );
      }
      const begun = beginning.result;
      assert.ok(begun);
      if (row.blocker !== undefined && row.blocker.length > 0) {
        assert.notEqual(method.availability, "enabled");
        assert.equal(
          begun.status,
          "unavailable",
          "unimplemented rows stay explicit and never count as enrolled",
        );
        receipt.outcome = "blocked";
        receipt.failure = { at: phase, error: row.blocker };
        continue;
      }
      assert.equal(begun.status, "ok");
      let operation = begun.value.operation;
      if (isExtensibility) {
        phase = "rr-pending-operation-recovery-after-native-recomposition";
        assert.equal(operation.state, "pending");
        assert.ok(operation.native);
        assert.equal(operation.native.method.interaction.kind, "browser");
        assert.ok(rollback);
        await rollback.probe("pending", {
          consumerId: fixture.consumerId,
          operationId: "rr-joined-" + nonce,
          pool,
          kernel,
          store,
        });
        report({ phase: "pending-recovery", rowId: row.id });
        await handshake({ phase: "pending-recovery-ready", rowId: row.id });
        const reads = catalogReads;
        discovery = false;
        // A new consumer instance has only the operation nonce. The source
        // service was recomposed over its actual PostgreSQL journal above.
        adapter = createAdapter();
        const recovered = await adapter.read("authorized", nonce);
        assert.equal(recovered.status, "ok");
        assert.equal(recovered.value.state, "pending");
        assert.deepEqual(recovered.value.native, operation.native);
        assert.equal(catalogReads, reads);
        receipt.pendingRecovery = true;
        operation = recovered.value;
      }
      for (const step of row.completion ?? []) {
        phase = "rr-completion";
        assert.equal(operation.state, "pending");
        const fields = await nativeCompletion(row, step, begun.value.authorizationURL);
        if (step.action === "poll") {
          assert.ok(begun.value.deviceAuthorization);
          await delay(begun.value.deviceAuthorization.intervalSeconds * 1000);
        }
        const completed = await adapter.continue(
          "authorized",
          nonce,
          step.action === "submit" ? fields : undefined,
        );
        assert.equal(completed.status, "ok");
        operation = completed.value;
      }
      assert.equal(operation.state, "applied");
      if (isExtensibility) {
        assert.ok(rollback);
        await rollback.probe("applied", {
          consumerId: fixture.consumerId,
          operationId: "rr-joined-" + nonce,
          pool,
          kernel,
          store,
        });
        report({ phase: "pending-recovery-complete", rowId: row.id });
        await handshake({ phase: "pending-recovery-restored", rowId: row.id });
      }
      discovery = true;
      assert.ok(operation.native);
      assert.deepEqual(operation.native.connection, selection);
      assert.deepEqual(operation.native.credential, {
        credentialKind: row.credentialKind,
        credentialPolicy: row.credentialPolicy,
        refreshPolicy: row.refreshPolicy,
      });
      receipt.enrolled = true;
      if (row.methodId === "sso") {
        receipt.slowSSOMilliseconds = Date.now() - started;
        assert.ok(
          receipt.slowSSOMilliseconds >= 30_000,
          "real SSO pending exceeded the old SDK/facade ceilings",
        );
      }
      const saved = await client.readConnection("rr-joined-" + nonce);
      assert.equal(saved.operation.state, "applied");
      assert.equal(saved.operation.result?.kind, "account");
      accountRef = saved.operation.result.accountRef;
      ownedAccounts.set(accountRef, { accountRef, profileId: row.profileId });
      assert.ok(
        (await client.list({ ownerRef })).accounts.some(
          (account) => account.accountRef === accountRef,
        ),
        "legacy inventory retains every newly discovered native account",
      );
      phase = "rr-original-operation-recovery";
      discovery = false;
      const reads = catalogReads;
      const recovered = await adapter.read("authorized", nonce);
      assert.equal(recovered.status, "ok");
      assert.deepEqual(recovered.value.native, operation.native);
      assert.equal(catalogReads, reads);
      receipt.recovery = true;
      discovery = true;
      if (extensionModule) {
        phase = "rr-native-models-and-limits";
        assert.ok(rawProfile);
        assert.ok(extensionProof);
        extensionObserver = await extensionModule.createExtensionObserver({
          origin,
          managementToken: token,
          consumerToken,
          ownerRef,
          accountRef,
          profile: rawProfile,
          modelId: row.model,
        });
        extensionProof.beforeReview = await extensionObserver.beforeReview();
      }
      if (row.execute) {
        phase = "actual-rr-review";
        if (reviewEnvironmentBlocker) {
          receipt.failure = reviewEnvironmentBlocker;
        } else {
          try {
            reviewSource ??= await reviewConsumer();
            const before = reviewSource.joinedProviderReceipts.length;
            await reviewSource.acceptProvider({
              origin,
              token: consumerToken,
              accountRef,
              profileId: row.profileId,
              model: row.model,
              limits,
              ...(row.reviewProof ? { reviewProof: row.reviewProof } : {}),
              ...(extensionObserver ? { beforeDispatch: extensionObserver.beforeDispatch } : {}),
            });
            assert.equal(reviewSource.joinedProviderReceipts.length, before + 1);
            const proof = reviewSource.joinedProviderReceipts[before];
            assert.equal(proof.profileId, row.profileId);
            assert.ok(
              proof.providerEntries >= 2 &&
                proof.streamCompletions >= 2 &&
                proof.structuredOutputRequests > 0,
            );
            assert.equal(proof.executionClosureAcknowledged, true);
            assert.equal(proof.sandboxQualification?.contract, "codex-read-only-sandbox/v1");
            assert.equal(proof.sandboxQualification.childExecuted, true);
            if (row.reviewProof) {
              assert.equal(proof.reasoningOmitted, false);
              assert.equal(proof.reasoningEffort, row.reviewProof.reasoningEffort);
              assert.equal(proof.reasoningRequests, 2);
              assert.ok((proof.reasoningContinuations ?? 0) > 0);
            }
            reviews.push({ rowId: row.id, executionFamily: row.executionFamily, proof });
            if (extensionObserver) {
              assert.ok(extensionProof);
              extensionProof.afterReview = await extensionObserver.afterReview();
            }
            receipt.review = "passed";
          } catch (error) {
            receipt.review = "failed";
            receipt.failure = safeFailure(error, phase);
            if (receipt.failure.code?.includes("cli_sandbox_preflight") === true) {
              reviewEnvironmentBlocker = receipt.failure;
            }
          }
        }
      }
      if (extensionProof) {
        phase = "active-gateway-provider-credential-scan";
        extensionProof.activeCredentialScan = await assertCredentialsAbsent(
          pool,
          extensionSentinels,
        );
      }
      phase = "retained-native-lifecycle";
      const original = await lifecycle.get(accountRef);
      assert.equal(
        (
          await lifecycle.suspend(accountRef, {
            operationId: randomUUID(),
            expectedMetadataRevision: original.metadataRevision,
          })
        ).state,
        "applied",
      );
      const retained = await lifecycle.get(accountRef);
      assert.equal(retained.state, "suspended");
      assert.equal(
        (
          await lifecycle.resume(accountRef, {
            operationId: randomUUID(),
            expectedMetadataRevision: retained.metadataRevision,
          })
        ).state,
        "applied",
      );
      assert.equal((await lifecycle.get(accountRef)).state, "active");
      receipt.lifecycle = true;
      if (receipt.reconnect !== "not_requested") {
        phase = "rr-native-reconnect";
        const current = await client.get(accountRef),
          replacementNonce = randomUUID();
        const replacement = await adapter.begin(
          "authorized",
          {
            nonce: replacementNonce,
            connection: selection,
            existing: {
              connectionId: accountRef,
              gatewayRevision: current.metadataRevision,
              mirrorRevision: 1,
            },
          },
          row.reconnectFields ?? {},
        );
        assert.equal(replacement.status, "ok");
        let replaced = replacement.value.operation;
        for (const step of row.reconnectCompletion ?? []) {
          assert.equal(replaced.state, "pending");
          const fields = await nativeCompletion(row, step, replacement.value.authorizationURL);
          if (step.action === "poll") {
            assert.ok(replacement.value.deviceAuthorization);
            await delay(replacement.value.deviceAuthorization.intervalSeconds * 1000);
          }
          const completed = await adapter.continue(
            "authorized",
            replacementNonce,
            step.action === "submit" ? fields : undefined,
          );
          assert.equal(completed.status, "ok");
          replaced = completed.value;
        }
        assert.equal(replaced.state, "applied");
        assert.deepEqual(replaced.native?.connection, selection);
        const savedReplacement = await client.readConnection("rr-joined-" + replacementNonce);
        assert.equal(savedReplacement.operation.state, "applied");
        assert.equal(savedReplacement.operation.result?.kind, "account");
        assert.equal(savedReplacement.operation.result.accountRef, accountRef);
        assert.deepEqual(replaced.native.credential, operation.native.credential);
        receipt.reconnect = "passed";
      }
      phase = "canonical-native-erasure";
      const current = await client.get(accountRef),
        retirement = randomUUID();
      assert.equal(
        (
          await client.disable(accountRef, {
            operationId: retirement,
            expectedMetadataRevision: current.metadataRevision,
          })
        ).state,
        "applied",
      );
      retired = true;
      await drainCleanup();
      const retirementStatus = await client.retirement(accountRef, retirement);
      assert.equal(retirementStatus.state, "completed");
      assert.equal(retirementStatus.inert, true);
      receipt.erased = true;
      if (extensionProof) {
        phase = "retired-gateway-provider-credential-scan";
        extensionProof.retiredCredentialScan = await assertCredentialsAbsent(
          pool,
          extensionSentinels,
        );
        if (extensionObserver && receipt.review === "passed") {
          phase = "rr-historical-usage-after-native-erasure";
          extensionProof.afterRetirement = await extensionObserver.afterRetirement();
        }
      }
      receipt.outcome =
        receipt.review === "failed"
          ? "failed"
          : receipt.review === "not_run"
            ? "blocked"
            : "passed";
    } catch (error) {
      receipt.outcome = "failed";
      receipt.failure = safeFailure(error, phase);
    } finally {
      discovery = true;
      if (accountRef !== undefined && accountRef.length > 0 && !retired) {
        try {
          const current = await client.get(accountRef);
          await client.disable(accountRef, {
            operationId: randomUUID(),
            expectedMetadataRevision: current.metadataRevision,
          });
          await drainCleanup();
        } catch {
          /* The failed row cannot be qualified by best-effort cleanup. */
        }
      }
      report({ phase: "case-result", ...receipt });
    }
  }
  phase = "lost-provider-ack-retained-unknown";
  let lostGrantNotReplayed: boolean | "not_in_batch" = "not_in_batch";
  const negativeFailures: NonNullable<RowReceipt["failure"]>[] = [];
  if (fixture.private.grokLostRefresh) {
    try {
      const row = rows.find((candidate) => candidate.id === fixture.private.grokLostRefreshRowId);
      assert.ok(row);
      report({ phase: "case", rowId: row.id });
      await handshake({ phase: "case-ready", rowId: row.id });
      const method = profiles
        .find((profile) => profile.id === row.profileId)
        ?.connection?.nativeMethods?.find((candidate) => candidate.methodId === row.methodId);
      assert.ok(method);
      const nonce = randomUUID();
      const unknown = await adapter.begin(
        "authorized",
        {
          nonce,
          connection: {
            profileId: row.profileId,
            methodId: row.methodId,
            methodRevision: method.revision,
            configurationGeneration: method.configurationGeneration,
          },
        },
        { refresh_token: fixture.private.grokLostRefresh },
      );
      assert.equal(unknown.status, "ok");
      assert.equal(unknown.value.operation.state, "unknown");
      assert.ok(rollback);
      await rollback.probe("unknown", {
        consumerId: fixture.consumerId,
        operationId: "rr-joined-" + nonce,
        pool,
        kernel,
        store,
      });
      discovery = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const recovered = await adapter.read("authorized", nonce);
        assert.equal(recovered.status, "ok");
        assert.equal(recovered.value.state, "unknown");
        assert.equal(recovered.value.native?.connection.methodId, row.methodId);
      }
      lostGrantNotReplayed = true;
    } catch (error) {
      negativeFailures.push(safeFailure(error, phase));
    }
  }
  const passed = receipts.filter((receipt) => receipt.outcome === "passed").length;
  const failed = receipts.filter((receipt) => receipt.outcome === "failed").length;
  const blocked = receipts.filter((receipt) => receipt.outcome === "blocked").length;
  const compatibilityStates = rollback?.cases.map((entry) => entry.gatewayState).toSorted() ?? [];
  const expectedCompatibilityStates = isExtensibility
    ? ["applied", "pending"]
    : fixture.batch === "standard"
      ? ["unknown"]
      : [];
  const gatewayCompatibility = {
    qualified: JSON.stringify(compatibilityStates) === JSON.stringify(expectedCompatibilityStates),
    ...(rollback
      ? {
          readerSHA: rollback.build.readerSHA,
          bundleSHA256: rollback.build.bundleSHA256,
          dependencySHA256: rollback.build.dependencySHA256,
          oldSourceGraphSHA256: rollback.build.oldSourceGraphSHA256,
        }
      : {}),
    cases: rollback?.cases ?? [],
  };
  const extensionComplete =
    !isExtensibility ||
    (extensionProof?.setup?.formSubmitted === true &&
      extensionProof.beforeReview !== undefined &&
      extensionProof.afterReview !== undefined &&
      extensionProof.afterRetirement !== undefined &&
      extensionProof.activeCredentialScan?.absent === true &&
      extensionProof.retiredCredentialScan?.absent === true &&
      receipts.every((row) => row.pendingRecovery === true));
  const qualified =
    failed === 0 &&
    blocked === 0 &&
    negativeFailures.length === 0 &&
    extensionComplete &&
    gatewayCompatibility.qualified;
  const consumerBuildDigestAfter = consumerBuildDigest((await loadConsumers()).provenance);
  assert.equal(consumerBuildDigestAfter, consumerBuildDigestBefore);
  const receipt = {
    phase: qualified ? "completed" : "blocked",
    qualified,
    contract: isExtensibility
      ? "native-provider-extension-gateway-sdk-rr/v1"
      : "native-connections-gateway-sdk-rr-joined/v1",
    ...provenance,
    batch: fixture.batch,
    expectedInventoryRows: 53,
    ...(isExtensibility ? { expectedExtensionRows: 1 } : {}),
    batchRows: rows.length,
    passed,
    failed,
    blocked,
    enrolled: receipts.filter((row) => row.enrolled).length,
    reviewPassed: receipts.filter((row) => row.review === "passed").length,
    nativeCatalogBytes,
    publicCatalogBytes,
    discoveredProviders,
    consumerBuildDigestBefore,
    consumerBuildDigestAfter,
    gatewayCompatibility,
    ...(isExtensibility ? { extensionComplete, extensionProof } : {}),
    reviewSchemaSHA256,
    lostGrantNotReplayed,
    negativeFailures,
    rows: receipts,
    reviews,
  };
  await writeFile(
    join(required("GATEWAY_NATIVE_CONNECTION_JOINED_ARTIFACTS"), "gateway-rr-receipt.json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  report({
    phase: receipt.phase,
    contract: receipt.contract,
    qualified,
    batch: fixture.batch,
    passed,
    failed,
    blocked,
    enrolled: receipt.enrolled,
    reviewPassed: receipt.reviewPassed,
    lostGrantNotReplayed,
  });
  if (!qualified) {
    process.exitCode = 1;
  }
}
try {
  await main();
} catch (error) {
  report({
    phase: "failed",
    at: phase,
    error: error instanceof Error ? error.name : "failure",
    // Assert messages may contain submitted credentials. Only source locations
    // are diagnostic; neither the message nor actual/expected values are logged.
    locations:
      error instanceof Error
        ? error.stack
            ?.split("\n")
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 4)
        : [],
  });
  process.exitCode = 1;
} finally {
  frames?.close();
  await heartbeat?.();
  await rollback?.close();
  for (const server of servers.toReversed()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  await pool?.end();
}
