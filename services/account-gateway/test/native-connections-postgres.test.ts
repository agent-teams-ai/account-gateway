// Real SDK -> facade -> durable kernel/journal -> fixed native HTTP adapter and
// protected owner callbacks. The native peer is a synthetic local contract
// fixture; joined native/provider qualification is an independent required gate.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import * as c from "@agent-teams/account-gateway/contracts";
import {
  createManagementClient,
  createLifecycleClient,
  createLifecycleV3Client,
  GatewayError,
} from "@agent-teams/account-gateway/http";
import { PostgresKernel } from "../src/postgres.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { createFacade } from "../src/facade.ts";
import {
  composeServiceControl,
  composeServiceNative,
  loadNativeConnectionProfiles,
} from "../src/service-assembly.ts";
import type { ServiceConfig } from "../src/service-config.ts";

let pool: Pool;
let nextNativeId = 70_000;
before(async () => {
  const database = process.env.AG_MANAGEMENT_DISPOSABLE_DB;
  const dsn = process.env.AG_MANAGEMENT_TEST_DSN;
  if (
    database === undefined ||
    database === "" ||
    !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
    dsn === undefined ||
    dsn === "" ||
    process.env.AG_KERNEL_TEST_ALLOW !== "disposable_pg17_10"
  ) {
    throw new Error("NOT_RUN: explicit fresh local disposable PostgreSQL 17.10 required");
  }
  const url = new URL(dsn);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/" + database ||
    url.search ||
    url.hash
  ) {
    throw new Error("refusing an unspecified or remote fixture");
  }
  pool = new Pool({
    connectionString: dsn,
    max: 6,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
  });
  pool.on("error", () => {});
  const version = (
    await pool.query<{ version: string; db: string }>(
      "SELECT current_setting('server_version') AS version,current_database() AS db",
    )
  ).rows[0];
  assert.equal(version.db, database);
  assert.match(version.version, /^17\.10(?:$| )/);
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')"))
      .rowCount,
    0,
  );
  const directory = new URL("../migrations/", import.meta.url);
  for (const migration of (await readdir(directory))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .toSorted()) {
    await pool.query(await readFile(new URL(migration, directory), "utf8"));
  }
});
after(async () => {
  await pool.end();
});

const profileId = "fixture-native-connection-v1",
  ownerRef = "workspace-fixture";
const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const legacyCallback =
  "http://localhost:1455/auth/callback?code=write-only-native-code&state=" + "a".repeat(64);
const legacyAuthorization =
  "https://auth.openai.com/oauth/authorize?" +
  new URLSearchParams({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    response_type: "code",
    redirect_uri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    code_challenge_method: "S256",
    code_challenge: "a".repeat(43),
    state: "b".repeat(32),
  });
const common = {
  revision: 1,
  configurationGeneration: "original-native-target",
  create: true,
  reconnect: true,
  requirements: [...c.CONNECTION_REQUIRED_CAPABILITIES],
  availability: "enabled" as const,
};
const methods: c.SupportedConnectionMethodV3[] = [
  {
    ...common,
    methodId: "cloud_document",
    label: "Structured cloud identity",
    allowedCredentialPolicies: ["cloud_identity"],
    interaction: {
      kind: "credential_form",
      inputFields: [
        {
          fieldId: "document",
          label: "Native document",
          kind: "document",
          required: true,
          maxBytes: 65_536,
        },
      ],
    },
  },
  {
    ...common,
    methodId: "native_browser",
    label: "Browser",
    allowedCredentialPolicies: ["subscription_session"],
    interaction: { kind: "browser", callbackMode: "manual", completionInputKind: "callback_url" },
  },
  {
    ...common,
    methodId: "native_device",
    label: "Device",
    allowedCredentialPolicies: ["cloud_identity"],
    interaction: { kind: "device" },
  },
  {
    ...common,
    methodId: "provider_key",
    label: "Provider key",
    allowedCredentialPolicies: ["provider_key"],
    interaction: {
      kind: "credential_form",
      inputFields: [
        { fieldId: "native_key", label: "Key", kind: "secret", required: true, maxBytes: 4096 },
      ],
    },
  },
];
function binding(methodId: string): c.ConnectionBinding {
  return {
    profileId,
    methodId,
    methodRevision: 1,
    configurationGeneration: common.configurationGeneration,
  };
}
const profile = {
  profileId,
  provider: { id: "fixture_new_provider", label: "New native provider" },
  product: { id: "fixture_new_product", label: "Native product" },
  region: { id: "global", label: "Global" },
  protocol: "openai-responses" as const,
  models: [
    {
      modelId: "fixture-model",
      reasoning: null,
      fast: null,
      tools: { default: "function" as const, allowed: ["function" as const] },
    },
  ],
  modelPolicy: {
    contract: c.NATIVE_ACCOUNT_MODELS_V2_CONTRACT,
    sourceId: "fixture_native_models",
    unavailableFallback: "deny" as const,
  },
  methods,
  accountInfo: false,
  limitsContract: "account-limits/v3" as const,
  availability: "enabled" as const,
  mount: {
    baseURL: "https://fixture.invalid/v1",
    model: "fixture-model",
    qualificationRef: "fixture-qualified-binding",
  },
  legacyAliases: [
    { kind: "api_key", connection: binding("provider_key"), inputFieldId: "native_key" },
    { kind: "browser", connection: binding("native_browser") },
  ],
};
type Scope = {
  operation: string;
  owner_ref: string;
  account_ref: string;
  generation: string;
  connection: c.ConnectionBinding;
};
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
function attestation(method: string): c.CredentialAttestation {
  return method === "provider_key"
    ? { credentialKind: "api_key", credentialPolicy: "provider_key", refreshPolicy: "none" }
    : method === "native_browser"
      ? {
          credentialKind: "oauth",
          credentialPolicy: "subscription_session",
          refreshPolicy: "native",
        }
      : { credentialKind: "native", credentialPolicy: "cloud_identity", refreshPolicy: "none" };
}
async function fixture() {
  const context = { consumerId: "native-connections-" + randomUUID() },
    worker = randomUUID();
  const kernel = new PostgresKernel(pool),
    custody = new IntentSecrets(randomBytes(32), randomBytes(32));
  const store = new PostgresManagementStore(pool, custody);
  const enrollment = {
    originRef: "fixture-native-process",
    engineIncarnation: randomUUID(),
    qualificationRef: "fixture-deployment",
  };
  const consumer = {
    consumerId: context.consumerId,
    managementCredential: "fixture-native-management",
    cleanupCredential: "fixture-native-cleanup",
    executionCredential: "fixture-native-execution",
    callbackCredential: "fixture-native-callback",
  };
  const token = "fixture-public-management",
    intentHmacKey = randomBytes(32);
  const intents = new Map<string, { scope: Scope; state: "prepared" | "completed"; id: number }>();
  const counts = { begin: 0, submit: 0, poll: 0, refresh: 0, erase: 0 };
  const erased = new Set<string>();
  let withdrawn = false,
    dropSubmit = false,
    dropErase = false,
    callbackOrigin = "",
    fault: unknown;
  const callOwner = async (purpose: string, scope: Scope, extra: object = {}) => {
    const response = await fetch(
      callbackOrigin + "/private/native/v1/oauth-" + purpose + "-authority",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + consumer.callbackCredential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          consumerId: context.consumerId,
          operationId: scope.operation,
          accountRef: scope.account_ref,
          generation: scope.generation,
          ...extra,
        }),
        signal: AbortSignal.timeout(4000),
      },
    );
    assert.equal(response.status, 200);
    const authority = (await response.json()) as { ownerRef: string; native?: unknown };
    assert.equal(authority.ownerRef, ownerRef);
    return authority;
  };
  const physical = (scope: Scope, id: number) => ({
    account_id: id,
    generation: scope.generation,
    created_at: "2026-11-21T00:00:00.123456789Z",
    profile: profileId,
    base_url: profile.mount.baseURL,
    model: profile.mount.model,
    publication: {
      connection: scope.connection,
      credential: attestation(scope.connection.methodId),
      dispatchFamily: "fixture_new_dispatch",
      authFamily: "fixture_new_auth",
    },
  });
  const native = createServer((req, res) => {
    void (async () => {
      assert.equal(
        req.headers.authorization,
        "Bearer " +
          (req.url === "/private/native/v2/connections/cleanup"
            ? consumer.cleanupCredential
            : consumer.managementCredential),
      );
      res.setHeader("content-type", "application/json");
      if (req.url === "/private/native/v2/account-capabilities") {
        assert.equal(req.method, "GET");
        res.end(
          JSON.stringify({
            contract: "native-account-capabilities/v2",
            profiles: withdrawn ? [] : [profile],
            enrollment,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const rawChunk of req) {
        const chunk: unknown = rawChunk;
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString()) as Scope & {
        input_fields?: Record<string, string>;
        descriptor?: unknown;
        cleanup_ref?: string;
        cleanup_token?: string;
        action?: "read" | "erase";
      };
      const {
        input_fields: fields,
        descriptor: selected,
        cleanup_ref: cleanupRef,
        cleanup_token: cleanupToken,
        action: cleanupAction,
        ...scope
      } = raw;
      c.connectionBinding.parse(scope.connection);
      assert.equal(scope.connection.profileId, profileId);
      assert.equal(scope.owner_ref, ownerRef);
      const action = req.url?.replace("/private/native/v2/connections/", "");
      let intent = intents.get(scope.operation);
      if (action === "begin") {
        await callOwner("owner", scope);
        assert.equal(intent, undefined, "one native Begin for an accepted durable operation");
        counts.begin++;
        const method = methods.find((entry) => entry.methodId === scope.connection.methodId);
        assert.ok(method);
        assert.ok(
          await store.readJournal(context, scope.operation),
          "journal committed before sensitive ingress",
        );
        if (method.interaction.kind === "credential_form") {
          assert.ok(fields && Object.keys(fields).length === 1);
        }
        intent = {
          scope,
          state: method.interaction.kind === "credential_form" ? "completed" : "prepared",
          id: ++nextNativeId,
        };
        intents.set(scope.operation, intent);
      } else {
        assert.ok(intent);
        assert.deepEqual(scope, intent.scope, "original physical and semantic binding");
      }
      const ack = () => ({
        operation: scope.operation,
        account_ref: scope.account_ref,
        connection: scope.connection,
        state: intent.state,
      });
      if (action === "begin" || action === "read") {
        const challenge =
          action !== "begin" || intent.state !== "prepared"
            ? {}
            : scope.connection.methodId === "native_device"
              ? {
                  device_authorization: {
                    user_code: "FIXTURE-CODE",
                    verification_url: "https://fixture.invalid/device",
                    expires_at: new Date(Date.now() + 60_000).toISOString(),
                    interval_seconds: 1,
                  },
                }
              : { authorize_url: legacyAuthorization };
        res.end(JSON.stringify({ ...ack(), ...challenge }));
        return;
      }
      if (action === "submit" || action === "poll") {
        await callOwner("owner", scope);
        assert.equal(intent.state, "prepared");
        if (action === "submit") {
          assert.ok(fields?.completion !== undefined && fields.completion !== "");
          counts.submit++;
        } else {
          counts.poll++;
        }
        intent.state = "completed";
        if (dropSubmit && action === "submit") {
          dropSubmit = false;
          res.destroy();
          return;
        }
        res.end(JSON.stringify(ack()));
        return;
      }
      if (action === "refresh") {
        await callOwner("refresh", scope);
        counts.refresh++;
        res.end(JSON.stringify({ ...ack(), state: "idle" }));
        return;
      }
      if (action === "describe") {
        await callOwner("owner", scope);
        res.end(
          JSON.stringify({
            ...ack(),
            state: "staged",
            qualification: "controlled-source-v1",
            native: physical(scope, intent.id),
          }),
        );
        return;
      }
      if (action === "custody") {
        await callOwner("custody", scope);
        assert.deepEqual(selected, physical(scope, intent.id));
        res.end(
          JSON.stringify({
            contract: "native-retained-custody/v2",
            generation: scope.generation,
            native: physical(scope, intent.id),
            credential_kinds: [attestation(scope.connection.methodId).credentialKind],
            retention: { state: "inactive", credential: "retained" },
            proof: { authenticated: true },
          }),
        );
        return;
      }
      if (action === "cleanup") {
        const authority = await callOwner("cleanup", scope, {
          cleanupRef,
          cleanupToken,
          action: cleanupAction,
        });
        const descriptor = physical(scope, intent.id);
        if (cleanupAction === "erase") {
          // The existing owner callback attests physical birth. Selection and
          // credential publication remain bound by the immutable journal above.
          const { publication: _publication, ...birth } = descriptor;
          assert.deepEqual(authority.native, birth, "erasure binds the committed physical birth");
          assert.equal(erased.has(scope.generation), false, "one erasure despite a lost ACK");
          counts.erase++;
          erased.add(scope.generation);
          if (dropErase) {
            dropErase = false;
            res.destroy();
            return;
          }
        }
        res.end(
          JSON.stringify({
            operation: scope.operation,
            account_ref: scope.account_ref,
            connection: scope.connection,
            credentials_erased: erased.has(scope.generation),
            closure: erased.has(scope.generation) ? "closed" : "pending",
            native: descriptor,
          }),
        );
        return;
      }
      assert.fail("unexpected native action");
    })().catch((error: unknown) => {
      fault = error;
      res.statusCode = 500;
      res.end();
    });
  });
  const origin = await listen(native);
  const cfg = {
    native: {
      origin,
      executable: "/unused-fixture/native",
      sha256: "0".repeat(64),
      bootstrapFile: "/unused-fixture/bootstrap",
      authorityDir: "/unused-fixture/authority",
      originRef: enrollment.originRef,
      uid: 65534,
      gid: 65534,
    },
    consumer,
    nativeConnections: {
      contract: "native-account-capabilities/v2" as const,
      profiles: [{ profileId, limits, providerTokenUpperBound: 100 }],
    },
    bearers: [
      {
        role: "management" as const,
        token,
        consumerId: context.consumerId,
        ownerRefs: [ownerRef],
        profileIds: [profileId],
        preparation: {
          accountRefs: [],
          subjectRef: "fixture-management",
          policyRevision: 1,
          bindingRevision: 1,
          profileId,
          limits,
          maxRunMs: 60_000,
        },
      },
    ],
  } satisfies Pick<ServiceConfig, "native" | "consumer" | "nativeConnections" | "bearers">;
  let facade: Server | undefined, callbacks: Server | undefined;
  let control: ReturnType<typeof composeServiceControl>;
  let client: ReturnType<typeof createManagementClient>;
  let lifecycle: ReturnType<typeof createLifecycleV3Client>;
  let oldLifecycle: ReturnType<typeof createLifecycleClient>;
  async function start() {
    await close(facade);
    await close(callbacks);
    await kernel.heartbeat(context, worker);
    const snapshot = await loadNativeConnectionProfiles(cfg);
    assert.ok(snapshot);
    control = composeServiceControl(cfg, kernel, store, custody, worker, undefined, snapshot);
    const bridge = composeServiceNative(cfg, control, kernel, store, { ...enrollment, worker });
    callbacks = bridge.authority.createServer();
    callbackOrigin = await listen(callbacks);
    facade = createFacade({
      kernel,
      management: control.management,
      store,
      bearers: control.bearers,
      profiles: control.catalog,
      intentHmacKey,
      lifecycle: { contract: c.LIFECYCLE_CAPABILITY_CONTRACT, writeGate: "enabled" },
    });
    const publicOrigin = await listen(facade);
    client = createManagementClient({ role: "management", token, origin: publicOrigin });
    lifecycle = createLifecycleV3Client({
      role: "management",
      token,
      origin: publicOrigin,
      capability: c.LIFECYCLE_V3_CAPABILITY_CONTRACT,
      clientContract: c.LIFECYCLE_V3_CLIENT_CONTRACT,
    });
    oldLifecycle = createLifecycleClient({
      role: "management",
      token,
      origin: publicOrigin,
      capability: c.LIFECYCLE_CAPABILITY_CONTRACT,
      clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
    });
    return snapshot;
  }
  await start();
  return {
    context,
    worker,
    kernel,
    store,
    counts,
    get client() {
      return client;
    },
    get lifecycle() {
      return lifecycle;
    },
    get oldLifecycle() {
      return oldLifecycle;
    },
    get control() {
      return control;
    },
    async withdraw() {
      withdrawn = true;
      return start();
    },
    dropCompletionACK() {
      dropSubmit = true;
    },
    dropErasureACK() {
      dropErase = true;
    },
    async stop() {
      await close(facade);
      await close(callbacks);
      await close(native);
      if (fault !== undefined) {
        throw fault instanceof Error ? fault : new Error("native fixture failure");
      }
    },
  };
}
function created(result: c.ConnectionOperation): string {
  assert.equal(result.operation.state, "applied");
  assert.ok(result.operation.result?.kind === "account");
  return result.operation.result.accountRef;
}

void test("native methods use one durable flow; structured custody, lifecycle and frozen aliases remain truthful", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.client.getProviderConnectionCapabilitiesV3()).capabilities[0].provider.id,
      "fixture_new_provider",
    );
    const secret = "write-only-cloud-document";
    const formId = randomUUID();
    const form = await f.client.beginConnection({
      operationId: formId,
      ownerRef,
      displayName: "Cloud fixture",
      connection: binding("cloud_document"),
      inputFields: { document: secret },
    });
    const accountRef = created(form);
    assert.equal(form.connection.credential?.credentialKind, "native");
    const account = await f.lifecycle.get(accountRef);
    assert.equal(account.authKind, "native");
    assert.equal(account.credential?.refreshPolicy, "none");
    assert.equal((await f.client.get(accountRef)).profileId, profileId);
    assert.ok(
      (await f.client.list({ ownerRef })).accounts.some((row) => row.accountRef === accountRef),
    );
    await assert.rejects(
      f.oldLifecycle.get(accountRef),
      (error: unknown) =>
        error instanceof GatewayError &&
        error.code === "safe_error" &&
        error.diagnostic?.code === "upstream_failure" &&
        error.effect === "not_dispatched",
    );
    const suspended = await f.lifecycle.suspend(accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: account.metadataRevision,
    });
    assert.equal(suspended.state, "applied");
    const retained = await f.lifecycle.get(accountRef);
    assert.equal(retained.resumeCustody, "verified");
    const resumed = await f.lifecycle.resume(accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: retained.metadataRevision,
    });
    assert.equal(resumed.state, "applied");
    assert.equal((await f.lifecycle.operation(suspended.operationRef)).state, "applied");
    const browserId = randomUUID();
    const browser = await f.client.beginConnection({
      operationId: browserId,
      ownerRef,
      displayName: "Browser fixture",
      connection: binding("native_browser"),
    });
    assert.equal(browser.challenge?.kind, "browser");
    assert.equal(
      (await f.client.readConnection(browserId)).connection?.method.interaction.kind,
      "browser",
    );
    created(
      await f.client.submitConnection({
        operationId: browserId,
        ownerRef,
        inputFields: { completion: "opaque-native-callback" },
      }),
    );
    const deviceId = randomUUID();
    assert.equal(
      (
        await f.client.beginConnection({
          operationId: deviceId,
          ownerRef,
          displayName: "Device fixture",
          connection: binding("native_device"),
        })
      ).challenge?.kind,
      "device",
    );
    created(await f.client.pollConnection({ operationId: deviceId, ownerRef }));
    const legacyId = randomUUID();
    const legacy = await f.client.connect({
      operationId: legacyId,
      ownerRef,
      profileId,
      displayName: "Legacy alias fixture",
      credential: { kind: "api_key", value: "write-only-native-key" },
    });
    assert.equal(legacy.state, "applied");
    assert.equal((await f.kernel.operation(f.context, legacyId)).legacyConnectionKind, "api_key");
    assert.deepEqual(
      { begin: f.counts.begin, submit: f.counts.submit, poll: f.counts.poll },
      { begin: 4, submit: 1, poll: 1 },
    );
    const safe = await pool.query<{ intent: unknown; connection_snapshot: unknown }>(
      `SELECT o.intent,j.connection_snapshot FROM ag_kernel.operations o JOIN ag_management.candidate_journal j
       ON o.consumer=j.consumer AND o.id=j.operation_id WHERE o.consumer=$1`,
      [f.context.consumerId],
    );
    const serialized = JSON.stringify(safe.rows);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("write-only-native-key"), false);
    const original = await f.store.readJournal(f.context, formId);
    assert.ok(original);
    const stored = await f.store.mapping(f.context, original.generation);
    assert.ok(stored?.descriptor.publication);
    await assert.rejects(
      f.store.saveMapping({
        ...stored,
        descriptor: {
          ...stored.descriptor,
          publication: {
            ...stored.descriptor.publication,
            connection: {
              ...stored.descriptor.publication.connection,
              configurationGeneration: "changed-target",
            },
          },
        },
      }),
      { message: "conflict" },
    );
  } finally {
    await f.stop();
  }
});

void test("withdrawn catalog preserves original readback and lost sensitive completion cannot replay", async () => {
  const f = await fixture();
  try {
    const operationId = randomUUID();
    const begun = await f.client.beginOAuth({
      operationId,
      ownerRef,
      profileId,
      displayName: "Legacy browser alias",
    });
    assert.equal(begun.operation.state, "pending");
    const accepted = await f.client.readConnection(operationId);
    assert.equal(
      accepted.connection?.connection.configurationGeneration,
      common.configurationGeneration,
    );
    const empty = await f.withdraw();
    assert.equal(empty.profiles.length, 0);
    assert.equal((await f.client.getProviderConnectionCapabilitiesV3()).capabilities.length, 0);
    assert.equal(f.control.management.supportsConnectionRecovery(), true);
    assert.deepEqual(await f.client.readConnection(operationId), accepted);
    await assert.rejects(
      f.client.beginConnection({
        operationId: randomUUID(),
        ownerRef,
        displayName: "Withdrawn",
        connection: binding("cloud_document"),
        inputFields: { document: "must-never-enter" },
      }),
      (error: unknown) =>
        error instanceof GatewayError &&
        error.code === "safe_error" &&
        error.diagnostic?.code === "forbidden" &&
        error.effect === "not_dispatched",
    );
    f.dropCompletionACK();
    const unknown = await f.client.completeOAuth({
      operationId,
      ownerRef,
      callbackURL: legacyCallback,
    });
    assert.equal(unknown.state, "unknown");
    assert.equal((await f.client.readConnection(operationId)).operation.state, "unknown");
    assert.equal(
      (await f.client.completeOAuth({ operationId, ownerRef, callbackURL: legacyCallback })).state,
      "unknown",
    );
    assert.equal(f.counts.begin, 1);
    assert.equal(f.counts.submit, 1);
  } finally {
    await f.stop();
  }
});

void test("reconnect preserves historical attestation and deletion recovers a lost native erasure ACK", async () => {
  const f = await fixture();
  try {
    const browserId = randomUUID();
    await f.client.beginConnection({
      operationId: browserId,
      ownerRef,
      displayName: "Original OAuth",
      connection: binding("native_browser"),
    });
    const accountRef = created(
      await f.client.submitConnection({
        operationId: browserId,
        ownerRef,
        inputFields: { completion: "native-one-time-code" },
      }),
    );
    const original = await f.lifecycle.get(accountRef);
    const suspended = await f.lifecycle.suspend(accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: original.metadataRevision,
    });
    const retained = await f.lifecycle.get(accountRef);
    await f.lifecycle.resume(accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: retained.metadataRevision,
    });
    const resumed = await f.lifecycle.get(accountRef);
    const reconnect = {
      operationId: randomUUID(),
      expectedMetadataRevision: resumed.metadataRevision,
      connection: binding("cloud_document"),
      inputFields: { document: "new-cloud-identity" },
    };
    assert.equal(created(await f.client.reconnectConnection(accountRef, reconnect)), accountRef);
    await assert.rejects(
      f.client.reconnectConnection(accountRef, {
        ...reconnect,
        inputFields: { document: "changed-secret" },
      }),
      (error: unknown) => error instanceof GatewayError && error.diagnostic?.code === "conflict",
    );
    const current = await f.lifecycle.get(accountRef);
    assert.equal(current.authKind, "native");
    assert.equal(current.credential?.refreshPolicy, "none");
    const historical = await f.lifecycle.operation(suspended.operationRef);
    assert.equal(historical.state, "applied");
    assert.equal(historical.result.account.authKind, "oauth");
    assert.equal(historical.result.account.credential?.refreshPolicy, "native");
    assert.equal(f.counts.begin, 2, "conflicting input never reaches native");
    assert.equal(await f.control.management.cleanup(f.context), "erased");
    assert.equal(f.counts.erase, 1, "reconnect erases the original generation");

    const deletionId = randomUUID();
    const disabled = await f.client.disable(accountRef, {
      operationId: deletionId,
      expectedMetadataRevision: current.metadataRevision,
    });
    assert.equal(disabled.state, "applied");
    f.dropErasureACK();
    assert.equal(await f.control.management.cleanup(f.context), "erased");
    assert.equal(await f.control.management.cleanup(f.context), "idle");
    assert.equal(f.counts.erase, 2, "lost erase ACK uses readback, not another erasure");
    const retired = await f.client.retirement(accountRef, deletionId);
    assert.equal(retired.state, "completed");
    assert.equal(retired.inert, true);
    assert.equal(retired.counts.retainedGenerations, 2);
    assert.equal(retired.counts.settledNativeErasureGenerations, 2);
  } finally {
    await f.stop();
  }
});
