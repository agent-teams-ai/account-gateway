// Explicit controlled joint E2E: real public SDK/facade/management/native client,
// real Go native HTTP/service/repository/custody/descriptor and two fresh PG17 DBs.
// The Go fixture owns a local TLS OpenAI-shaped provider; no live account access.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { Pool } from "pg";
import {
  createAccountLimitsClient,
  createManagementClient,
  createConsumerControlClient,
  createExecutionClient,
  GatewayError,
} from "@agent-teams/account-gateway/http";
import { PostgresKernel } from "../src/postgres.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { codexOAuthProfile } from "../src/management.ts";
import { composeServiceControl, composeServiceNative } from "../src/service.ts";
import { createFacade } from "../src/facade.ts";
import { PostgresUsageJournal } from "../src/usage.ts";
import type { UsageJournal } from "../src/usage.ts";
import { physicallyClosed, receipt as nativeReceipt } from "../src/native-wire.ts";
import type { ServiceConfig } from "../src/service-config.ts";

const report = (value: object): void => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
let phase = "guard";
const servers: Server[] = [];
let pool: Pool | undefined;
let child: ReturnType<typeof spawn> | undefined;
let stopped = false;
let childExit: Promise<number | null> | undefined;
let cliChild: ReturnType<typeof spawn> | undefined;
let releaseTerminalUsage: (() => void) | undefined;
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}
async function bounded<T>(work: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("controlled joined timeout"));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function disposable(name: string, prefix: string): string {
  const raw = process.env[name];
  assert.ok(raw !== undefined && raw !== "");
  const url = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && url.port !== "5432");
  assert.equal(url.username, "postgres");
  assert.equal(url.password, "");
  assert.equal(url.pathname.startsWith("/" + prefix), true);
  assert.equal(url.hash, "");
  assert.equal(url.search, "?sslmode=disable");
  return raw;
}
const sha256 = async (url: URL): Promise<string> =>
  createHash("sha256")
    .update(await readFile(url))
    .digest("hex");

const denied = (error: unknown): boolean =>
  error instanceof GatewayError && error.diagnostic?.code === "forbidden";

async function run(): Promise<void> {
  assert.equal(process.env.AG_NATIVE_DEVICE_JOINED_ALLOW, "disposable_pg17_10");
  const nativeDSN = disposable("AG_NATIVE_DEVICE_JOINED_NATIVE_DSN", "native_device_joined_");
  const kernelDSN = disposable(
    "AG_NATIVE_DEVICE_JOINED_KERNEL_DSN",
    "ag_kernel_test_device_joined_",
  );
  const binary = process.env.AG_NATIVE_DEVICE_JOINED_BINARY;
  const cliBinary = process.env.AG_NATIVE_DEVICE_JOINED_CLI_BINARY;
  assert.ok(
    binary !== undefined &&
      binary !== "" &&
      isAbsolute(binary) &&
      binary.includes("/tmp/native-device-joined/"),
  );
  const binarySHA256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const buildInfo = execFileSync(
    process.env.AG_NATIVE_DEVICE_JOINED_GO ?? "go",
    ["version", "-m", binary],
    { encoding: "utf8", timeout: 5000, maxBuffer: 131072 },
  );
  const nativeHead = /vcs\.revision=([a-f0-9]{40})/.exec(buildInfo)?.[1];
  assert.ok(nativeHead !== undefined && nativeHead !== "");
  assert.match(buildInfo, /vcs\.modified=false/);
  let cliSHA256: string | undefined;
  let networkNamespace: string | undefined;
  if (cliBinary !== undefined) {
    assert.ok(isAbsolute(cliBinary));
    const expectedNative = process.env.AG_NATIVE_DEVICE_JOINED_NATIVE_COMMIT;
    assert.ok(expectedNative && /^[a-f0-9]{40}$/.test(expectedNative));
    assert.equal(nativeHead, expectedNative);
    const pins = JSON.parse(
      await readFile(new URL("./fixtures/native-cli/pins.json", import.meta.url), "utf8"),
    ) as {
      clients: { id: string; version: string; binarySHA256: string }[];
    };
    const pin = pins.clients.find((p) => p.id === "codex");
    assert.ok(pin);
    assert.equal(pin.version, "0.164.0-linux-x64");
    cliSHA256 = createHash("sha256")
      .update(await readFile(cliBinary))
      .digest("hex");
    assert.equal(cliSHA256, pin.binarySHA256);
    const evidencePath = process.env.AG_LOAD_NETWORK_EVIDENCE;
    assert.ok(evidencePath && isAbsolute(evidencePath));
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      networkNamespace?: string;
    };
    networkNamespace = await readlink("/proc/self/ns/net");
    assert.equal(evidence.networkNamespace, networkNamespace);
    const interfaces = (await readFile("/proc/net/dev", "utf8"))
      .trim()
      .split("\n")
      .slice(2)
      .map((line) => line.split(":")[0].trim());
    assert.deepEqual(interfaces, ["lo"]);
    assert.equal((await readFile("/proc/net/route", "utf8")).trim().split("\n").length, 1);
  }
  const gatewayRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const gatewayHead = cliBinary
    ? (process.env.AG_NATIVE_DEVICE_JOINED_GATEWAY_COMMIT ?? "")
    : execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gatewayRoot,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
  assert.match(gatewayHead, /^[a-f0-9]{40}$/);
  const sourceHashes = {
    harness: await sha256(new URL(import.meta.url)),
    nativeFixture: await sha256(
      new URL("./fixtures/native-device-joined/main.go", import.meta.url),
    ),
    sdkHTTP: await sha256(new URL(import.meta.resolve("@agent-teams/account-gateway/http"))),
  };
  const consumerId = "joined-device-" + randomUUID(),
    ownerRef = "joined-device-owner";
  const managementCredential = randomBytes(32).toString("base64url"),
    callbackCredential = randomBytes(32).toString("base64url");
  const nativeExecution = randomBytes(32).toString("base64url"),
    nativeCleanup = randomBytes(32).toString("base64url");
  const scratchRoot =
    process.env.AG_NATIVE_DEVICE_JOINED_SCRATCH_ROOT ??
    resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../tmp");
  if (cliBinary)
    assert.ok(
      process.env.AG_NATIVE_DEVICE_JOINED_SCRATCH_ROOT,
      "CLI mode requires task-owned scratch",
    );
  assert.ok(isAbsolute(scratchRoot));
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(scratchRoot, "native-device-joined-"));
  const configFile = join(scratch, "native-config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      DSN: nativeDSN,
      Consumer: consumerId,
      Control: managementCredential,
      Callback: callbackCredential,
      CLI: cliBinary !== undefined,
      Execution: nativeExecution,
      Cleanup: nativeCleanup,
    }),
    { mode: 0o600 },
  );
  phase = "native-start";
  child = spawn(binary, [configFile], {
    env: { GIN_MODE: "release" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin!.on("error", () => {});
  // Native diagnostics are retained privately, never reflected into public results.
  let diagnostic = "",
    nativeDiagnosticBytes = 0;
  child.stderr!.on("data", (bytes: Buffer) => {
    nativeDiagnosticBytes += bytes.length;
    if (diagnostic.length < 8192) diagnostic += bytes.toString();
  });
  childExit = new Promise((resolve) => {
    child!.once("error", () => {
      resolve(-1);
    });
    child!.once("close", resolve);
  });
  const frames = createInterface({ input: child.stdout!, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const next = async (event: string): Promise<Record<string, unknown>> => {
    const line = await bounded(frames.next());
    assert.equal(line.done, false);
    assert.ok(line.value.length <= 4096);
    const result = JSON.parse(line.value) as Record<string, unknown>;
    assert.equal(result.event, event);
    return result;
  };
  const ready = await next("ready");
  assert.equal(typeof ready.nativeOrigin, "string");
  assert.equal(typeof ready.controllerOrigin, "string");
  for (const origin of [ready.nativeOrigin, ready.controllerOrigin]) {
    const url = new URL(origin as string);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.protocol, "http:");
    assert.ok(url.port);
  }
  phase = "kernel-migrations";
  pool = new Pool({
    connectionString: kernelDSN,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  pool.on("error", () => {});
  const version = (
    await pool.query<{ db: string; version: string }>(
      "SELECT current_database() AS db,current_setting('server_version') AS version",
    )
  ).rows[0];
  assert.equal(version.db, new URL(kernelDSN).pathname.slice(1));
  assert.match(version.version, /^17\.10(?:$| )/);
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')"))
      .rowCount,
    0,
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .toSorted()) {
    await pool.query(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  const kernel = new PostgresKernel(pool),
    secrets = new IntentSecrets(randomBytes(32), randomBytes(32));
  const store = new PostgresManagementStore(pool, secrets),
    worker = randomUUID(),
    context = { consumerId };
  await kernel.issuer(context);
  await kernel.heartbeat(context, worker);
  const limits = {
    requests: 4,
    concurrency: 1,
    requestBytes: cliBinary ? 1_048_576 : 4096,
    outputBytes: cliBinary ? 1_048_576 : 4096,
    tokens: cliBinary ? 65536 : 100,
  };
  const limitsToken = randomBytes(32).toString("base64url");
  const publicToken = randomBytes(32).toString("base64url"),
    foreignToken = randomBytes(32).toString("base64url");
  const bearer = (token: string, owner: string) => ({
    token,
    role: "management" as const,
    consumerId,
    ownerRefs: [owner],
    profileIds: [codexOAuthProfile.profile],
    preparation: {
      accountRefs: [],
      subjectRef: "joined-device-policy",
      policyRevision: 1,
      bindingRevision: 1,
      profileId: codexOAuthProfile.profile,
      limits,
      maxRunMs: 60_000,
    },
  });
  const cfg = {
    native: {
      executable: "/unused",
      sha256: "unused",
      bootstrapFile: "/unused",
      authorityDir: "/unused",
      origin: ready.nativeOrigin as string,
      originRef: "joined-device-origin",
      uid: 1,
      gid: 1,
    },
    consumer: {
      consumerId,
      managementCredential,
      callbackCredential,
      executionCredential: nativeExecution,
      cleanupCredential: nativeCleanup,
    },
    profile: {
      profile: "openai-responses-apikey-v1",
      baseURL: "https://api.openai.com/v1",
      model: "fixture-unused",
      qualificationRef: "joined-device-unused-apikey",
      limits,
      providerTokenUpperBound: limits.tokens,
    },
    oauthEnrollment: {
      enabled: true,
      profile: "openai-codex-oauth-responses-v1",
      modelScope: ["gpt-5.6-sol"],
      qualificationRef: "controlled-source-v1",
      limits,
      providerTokenUpperBound: limits.tokens,
    },
    bearers: [
      bearer(publicToken, ownerRef),
      bearer(foreignToken, "joined-foreign-owner"),
      {
        token: limitsToken,
        role: "consumer-control",
        consumerId,
        profileIds: [codexOAuthProfile.profile],
        limits,
        maxRunMs: 60_000,
      },
    ],
  } satisfies Pick<
    ServiceConfig,
    "native" | "consumer" | "profile" | "oauthEnrollment" | "bearers"
  >;
  const control = composeServiceControl(cfg, kernel, store, secrets, worker);
  const journalUsage = new PostgresUsageJournal(pool, randomBytes(32));
  let terminalUsageStarted: (() => void) | undefined;
  const terminalUsageSeen = new Promise<void>((done) => {
    terminalUsageStarted = done;
  });
  const terminalUsagePermit = new Promise<void>((done) => {
    releaseTerminalUsage = done;
  });
  const usage: UsageJournal = {
    observe: journalUsage.observe.bind(journalUsage),
    list: journalUsage.list.bind(journalUsage),
    async append(ctx, fact) {
      if (cliBinary && fact.revision === 2 && fact.effect === "completed") {
        terminalUsageStarted!();
        await terminalUsagePermit;
      }
      await journalUsage.append(ctx, fact);
    },
  };
  const enrollment = { originRef: cfg.native.originRef, engineIncarnation: randomUUID(), worker };
  const { authority, transport } = composeServiceNative(
    cfg,
    control,
    kernel,
    store,
    enrollment,
    cliBinary ? usage : undefined,
  );
  const callbackOrigin = await listen(authority.createServer());
  const origin = await listen(
    createFacade({
      kernel,
      store,
      management: control.management,
      bearers: control.bearers,
      profiles: control.catalog,
      enrollment,
      transport,
      accountLimits: control.accountLimits,
      intentHmacKey: randomBytes(32),
      ...(cliBinary ? { usage } : {}),
    }),
  );
  child.stdin!.write(
    JSON.stringify({
      callbackOrigin,
      originRef: enrollment.originRef,
      engineIncarnation: enrollment.engineIncarnation,
      qualificationRef: cfg.profile.qualificationRef,
    }) + "\n",
  );
  const configured = await next("configured");
  const client = createManagementClient({ role: "management", origin, token: publicToken });
  const foreign = createManagementClient({ role: "management", origin, token: foreignToken });
  const command = {
    operationId: randomUUID(),
    ownerRef,
    profileId: codexOAuthProfile.profile,
    displayName: "Controlled joined device",
    method: "device_code" as const,
  };
  const poll = { operationId: command.operationId, ownerRef };
  const stats = async (): Promise<Record<string, number>> => {
    const response = await fetch(ready.controllerOrigin + "/stats", {
      headers: { authorization: "Bearer " + managementCredential },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, number>;
  };
  phase = "fresh-device-handoff";
  const begun = await client.beginOAuth(command);
  assert.equal(begun.operation.state, "pending");
  assert.ok(begun.deviceAuthorization);
  assert.equal(begun.deviceAuthorization.userCode, "JOIN-ED42");
  assert.equal(begun.deviceAuthorization.verificationURL, "https://auth.openai.com/codex/device");
  assert.equal(begun.deviceAuthorization.intervalSeconds, 1);
  assert.equal(begun.authorizationURL, undefined);
  const journal = await store.readJournal(context, command.operationId);
  assert.ok(journal);
  assert.equal((await client.get(journal.accountRef)).state, "staging");
  const duplicate = await client.beginOAuth(command);
  assert.equal(duplicate.deviceAuthorization, undefined);
  assert.equal((await client.readOAuth(command.operationId)).state, "pending");
  assert.deepEqual(await stats(), { starts: 1, polls: 0, exchanges: 0, checks: 0, unexpected: 0 });
  phase = "owner-boundary";
  await assert.rejects(foreign.pollDeviceOAuth(poll), denied);
  await assert.rejects(
    client.pollDeviceOAuth({ ...poll, ownerRef: "joined-foreign-owner" }),
    denied,
  );
  phase = "pending-provider-poll";
  await delay(1100);
  assert.equal((await client.pollDeviceOAuth(poll)).state, "pending");
  assert.deepEqual(await stats(), { starts: 1, polls: 1, exchanges: 0, checks: 0, unexpected: 0 });
  const accepted = await fetch(ready.controllerOrigin + "/authorize", {
    method: "POST",
    headers: { authorization: "Bearer " + managementCredential },
  });
  assert.equal(accepted.status, 200);
  await accepted.arrayBuffer();
  await delay(1100);
  phase = "authorized-native-custody-and-descriptor";
  const applied = await client.pollDeviceOAuth(poll);
  assert.equal(applied.state, "applied");
  assert.equal((await client.get(journal.accountRef)).state, "active");
  const mapping = await store.mapping(context, journal.generation);
  assert.ok(mapping);
  assert.equal(mapping.descriptor.generation, journal.generation);
  assert.equal(mapping.descriptor.profile, codexOAuthProfile.profile);
  assert.equal(mapping.descriptor.model, codexOAuthProfile.model);
  assert.equal(mapping.descriptor.nativePhysicalIdentity, journal.generation);
  assert.ok(mapping.descriptor.nativeId > 0);
  phase = "duplicate-and-readback-no-replay";
  for (const result of await Promise.all(
    Array.from({ length: 4 }, () => client.pollDeviceOAuth(poll)),
  )) {
    assert.equal(result.state, "applied");
  }
  assert.equal((await client.readOAuth(command.operationId)).state, "applied");
  assert.deepEqual(await client.beginOAuth(command), { operation: applied });
  const final = await stats();
  assert.deepEqual(final, { starts: 1, polls: 2, exchanges: 1, checks: 1, unexpected: 0 });
  assert.equal(
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ag_management.transient_intents WHERE consumer=$1",
        [consumerId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1",
        [consumerId],
      )
    ).rows[0].n,
    0,
  );
  phase = "cached-native-account-limits";
  const limitsClient = createAccountLimitsClient({
    role: "consumer-control",
    origin,
    token: limitsToken,
  });
  assert.deepEqual(await limitsClient.getAccountLimitsCapabilities(), {
    contract: "account-limits/v1",
    cachedRead: true,
    quotaOnlyRefresh: false,
  });
  const limitsInput = {
    ownerRef,
    accountRef: journal.accountRef,
    profileId: codexOAuthProfile.profile,
    expectedAuthorizationEpoch: (await kernel.account(context, journal.accountRef)).epoch,
  };
  assert.deepEqual(await limitsClient.readAccountLimits(limitsInput), { status: "unknown" });
  await assert.rejects(
    limitsClient.readAccountLimits({ ...limitsInput, ownerRef: "joined-foreign-owner" }),
    denied,
  );
  const controlLimits = async (path: string): Promise<void> => {
    const response = await fetch(ready.controllerOrigin + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + managementCredential,
        "content-type": "application/json",
      },
      body: JSON.stringify(limitsInput),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 204);
    await response.arrayBuffer();
  };
  await controlLimits("/limits/seed");
  const snapshot = await limitsClient.readAccountLimits(limitsInput);
  assert.equal(snapshot.status, "snapshot");
  if (!Object.is(snapshot.status, "snapshot")) {
    throw new Error("missing controlled snapshot");
  }
  assert.equal(snapshot.physicalGeneration, journal.generation);
  assert.match(snapshot.principalVersion, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.scope, "account");
  assert.deepEqual(snapshot.windows, [
    {
      id: "primary",
      family: "codex",
      durationSeconds: 18000,
      usedPercent: 37.5,
      observedAt: "2026-10-01T01:02:03.123456Z",
      resetAt: "2026-10-01T01:02:03.123456Z",
      basis: "duration",
    },
  ]);
  let rrAcceptance = false;
  const rrModule = process.env.AG_NATIVE_DEVICE_JOINED_RR_ACCEPTANCE_MODULE;
  if (rrModule !== undefined) {
    assert.ok(
      isAbsolute(rrModule) && rrModule.endsWith(".mts"),
      "RR acceptance module must be an explicit absolute .mts fixture",
    );
    // The operator explicitly preloads its consumer fixture. The source harness
    // keeps its dependency graph closed instead of loading arbitrary modules.
    const accept: unknown = Reflect.get(
      globalThis,
      Symbol.for("account-limits-e2e.acceptAccountLimits"),
    );
    assert.equal(typeof accept, "function", "RR acceptance fixture must be explicitly preloaded");
    await bounded(
      (
        accept as (input: {
          origin: string;
          token: string;
          input: typeof limitsInput;
        }) => Promise<void>
      )({ origin, token: limitsToken, input: limitsInput }),
    );
    rrAcceptance = true;
  }
  const beforeRename = await kernel.account(context, journal.accountRef);
  assert.equal(
    (
      await client.rename(journal.accountRef, {
        operationId: randomUUID(),
        expectedMetadataRevision: beforeRename.revision,
        displayName: "Renamed controlled limits",
      })
    ).state,
    "applied",
  );
  assert.deepEqual(
    await limitsClient.readAccountLimits(limitsInput),
    snapshot,
    "rename keeps observation and principal version",
  );
  let cliEvidence: Record<string, unknown> | undefined;
  if (cliBinary) {
    phase = "actual-codex-cli-through-real-authority";
    const inferenceOrigin = configured.inferenceOrigin;
    assert.equal(typeof inferenceOrigin, "string");
    const endpoint = new URL(inferenceOrigin as string);
    assert.equal(endpoint.protocol, "http:");
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.ok(endpoint.port);
    const consumer = createConsumerControlClient({
      role: "consumer-control",
      origin,
      token: limitsToken,
    });
    const access = await consumer.runAccess({
      operationId: randomUUID(),
      invocationRef: randomUUID(),
      attemptRef: randomUUID(),
      accountRefs: [journal.accountRef],
      subjectRef: "joined-device-cli-policy",
      policyRevision: 1,
      bindingRevision: 1,
      profileId: codexOAuthProfile.profile,
      limits,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(access.operation.state, "applied");
    assert.equal(access.operation.result?.kind, "execution");
    if (access.operation.result?.kind !== "execution")
      throw new Error("missing execution authority");
    const executionRef = access.operation.result.executionRef;
    const requestedModel = "gpt-5.4";
    assert.notEqual(requestedModel, codexOAuthProfile.model);
    assert.equal(mapping.descriptor.model, codexOAuthProfile.model);
    const work = join(scratch, "empty-project");
    await mkdir(work, { mode: 0o700 });
    const provider =
      '{name="ControlledJoinedGateway",base_url="' +
      inferenceOrigin +
      '/v1",env_key="AG_CLI_EXECUTION_CAPABILITY",wire_api="responses",request_max_retries=0,stream_max_retries=0,supports_websockets=false,requires_openai_auth=false}';
    cliChild = spawn(
      cliBinary,
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        "-m",
        requestedModel,
        "-c",
        'model_provider="fixture"',
        "-c",
        "model_providers.fixture=" + provider,
        "Return the local fixture answer.",
      ],
      {
        cwd: work,
        detached: true,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", AG_CLI_EXECUTION_CAPABILITY: access.bearer },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      outputBytes = 0,
      diagnosticBytes = 0,
      overflow = false,
      timedOut = false,
      cliExited = false;
    const killCLI = () => {
      if (!cliExited && cliChild?.pid) {
        try {
          process.kill(-cliChild.pid, "SIGKILL");
        } catch {}
      }
    };
    cliChild.stdout!.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 4_194_304) {
        overflow = true;
        killCLI();
      } else output += bytes.toString();
    });
    cliChild.stderr!.on("data", (bytes: Buffer) => {
      diagnosticBytes += bytes.length;
      if (diagnosticBytes > 4_194_304) {
        overflow = true;
        killCLI();
      }
    });
    const heartbeat = setInterval(() => {
      void kernel.heartbeat(context, worker).catch(() => killCLI());
    }, 5000);
    const timeout = setTimeout(() => {
      timedOut = true;
      killCLI();
    }, 55_000);
    const cliExit = new Promise<number | null>((done, fail) => {
      cliChild!.once("error", fail);
      cliChild!.once("close", (code) => {
        cliExited = true;
        done(code);
      });
    });
    // Capture a rejected spawn even while awaiting the independent SQL gate.
    void cliExit.catch(() => undefined);
    let exit: number | null;
    let originalProof: Awaited<ReturnType<PostgresKernel["requestProof"]>>;
    try {
      await bounded(
        Promise.race([
          terminalUsageSeen,
          cliExit.then(() => {
            throw new Error("CLI exited before terminal durability gate");
          }),
        ]),
        45_000,
      );
      const held = (
        await pool.query(
          `SELECT r.id,r.effect,r.transport_occupied,r.closure_acked_at,
        (SELECT max(revision) FROM ag_kernel.usage_observations u WHERE u.consumer=r.consumer AND u.execution_ref=r.execution_ref AND u.request_ref=r.id) AS usage_revision
        FROM ag_kernel.requests r WHERE r.consumer=$1 AND r.execution_ref=$2`,
          [consumerId, executionRef],
        )
      ).rows;
      assert.equal(held.length, 1);
      assert.equal(held[0].effect, "completed");
      assert.equal(held[0].transport_occupied, true);
      assert.equal(held[0].closure_acked_at, null);
      assert.equal(held[0].usage_revision, 0);
      const initialUsage = await usage.observe(context, executionRef, held[0].id);
      assert.equal(
        initialUsage?.model,
        requestedModel,
        "initial usage labels the admitted requested model",
      );
      originalProof = await kernel.requestProof(context, executionRef, held[0].id);
      assert.ok(originalProof);
      assert.equal(originalProof.worker, worker);
      assert.equal(originalProof.native?.generation, journal.generation);
      const heldRead = await fetch(
        ready.nativeOrigin + "/private/native/v1/transports/read-owner",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + nativeExecution,
            "content-type": "application/json",
          },
          body: JSON.stringify({ proof: originalProof }),
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(heldRead.status, 202);
      const heldReceipt = nativeReceipt(await heldRead.json(), consumerId, originalProof);
      assert.equal(physicallyClosed(heldReceipt), true);
      assert.equal(heldReceipt.acknowledged, false);
      // Even a trusted callback cannot change an existing request's model or
      // ACK closure with a missing/unbounded model while its client awaits EOF.
      for (const attemptedModel of [
        undefined,
        "invalid model",
        "x".repeat(129),
        codexOAuthProfile.model,
      ]) {
        const refused = await fetch(callbackOrigin + "/private/native/v1/execution-settle", {
          method: "POST",
          headers: {
            authorization: "Bearer " + callbackCredential,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            consumerId,
            proof: originalProof,
            receipt: heldReceipt,
            requestedModel: attemptedModel,
          }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(refused.status, 403);
        await refused.arrayBuffer();
      }
      const afterRefusals = (
        await pool.query(
          "SELECT transport_occupied,closure_acked_at FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3",
          [consumerId, executionRef, held[0].id],
        )
      ).rows[0];
      assert.equal(afterRefusals.transport_occupied, true);
      assert.equal(afterRefusals.closure_acked_at, null);
      assert.equal((await usage.observe(context, executionRef, held[0].id))?.model, requestedModel);
      await delay(100);
      assert.equal(
        cliExited,
        false,
        "actual CLI cannot exit before real terminal usage and closure acknowledgment",
      );
      const terminalBeforeDurability = output.split("\n").some((line) => {
        try {
          return JSON.parse(line).type === "turn.completed";
        } catch {
          return false;
        }
      });
      assert.equal(
        terminalBeforeDurability,
        false,
        "actual CLI cannot observe a completed turn before durable settlement",
      );
      releaseTerminalUsage!();
      exit = await cliExit;
    } finally {
      releaseTerminalUsage!();
      if (!cliExited) killCLI();
      clearInterval(heartbeat);
      clearTimeout(timeout);
      cliChild = undefined;
    }
    assert.ok(
      exit === 0 && !overflow && !timedOut,
      "pinned CLI must succeed with bounded private diagnostics",
    );
    let completed = false,
      answered = false;
    for (const line of output.split("\n")) {
      let event: { type?: string; item?: { type?: string; text?: string } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "turn.completed") completed = true;
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text === "Controlled local fixture reply."
      )
        answered = true;
    }
    output = "";
    assert.ok(completed && answered, "pinned CLI must parse the controlled terminal SSE result");
    const rows = (
      await pool.query(
        `SELECT id,effect,transport_occupied,closure_acked_at FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2`,
        [consumerId, executionRef],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].effect, "completed");
    assert.equal(rows[0].transport_occupied, false);
    assert.ok(rows[0].closure_acked_at);
    const proof = await kernel.requestProof(context, executionRef, rows[0].id);
    assert.ok(proof);
    assert.deepEqual(proof, originalProof);
    const nativeRead = await fetch(
      ready.nativeOrigin + "/private/native/v1/transports/read-owner",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + nativeExecution,
          "content-type": "application/json",
        },
        body: JSON.stringify({ proof }),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(nativeRead.status, 202);
    const closed = nativeReceipt(await nativeRead.json(), consumerId, proof);
    assert.ok(physicallyClosed(closed) && closed.acknowledged && closed.lifetime.completed);
    const observation = await consumer.observeUsage(executionRef, rows[0].id);
    assert.ok(observation);
    assert.equal(observation.revision, 2);
    assert.equal(observation.effect, "completed");
    assert.equal(observation.completeness, "complete");
    assert.equal(observation.inputTokens, 7);
    assert.equal(observation.outputTokens, 3);
    assert.equal(
      observation.model,
      requestedModel,
      "terminal usage preserves the requested model instead of the descriptor anchor",
    );
    const inferenceStats = await fetch(ready.controllerOrigin + "/inference-stats", {
      headers: { authorization: "Bearer " + managementCredential },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(inferenceStats.status, 200);
    assert.deepEqual(await inferenceStats.json(), { entries: 1, modelReads: 1 });
    phase = "actual-codex-cli-cleanup";
    const execution = createExecutionClient({ role: "execution", origin, token: access.bearer });
    assert.equal(
      (await execution.close(executionRef, { operationId: randomUUID(), reason: "completed" }))
        .state,
      "applied",
    );
    const cleanup = await kernel.claimCleanup(context, worker);
    assert.ok(cleanup?.scope.kind === "execution");
    assert.equal(cleanup.scope.executionRef, executionRef);
    assert.equal(cleanup.scope.transports.length, 0);
    await kernel.settleCleanup(context, cleanup.cleanupRef, worker, cleanup.token, true);
    const terminal = (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied) AS occupied,
      (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND state='open') AS open,
      (SELECT count(*)::int FROM ag_kernel.cleanup WHERE consumer=$1 AND state<>'done') AS unresolved`,
        [consumerId],
      )
    ).rows[0];
    assert.deepEqual(terminal, { occupied: 0, open: 0, unresolved: 0 });
    cliEvidence = {
      id: "codex",
      version: "0.164.0",
      binarySHA256: cliSHA256,
      exitCode: 0,
      parsedTerminalResult: true,
      outputBytes,
      diagnosticBytes,
      providerEntries: 1,
      protocol: "Responses HTTP/SSE",
      networkNamespace,
      realTypeScriptAuthority: true,
      realOAuthNativePostgres: true,
      sqlEffect: "completed",
      inputTokens: 7,
      outputTokens: 3,
      nativeClosed: true,
      nativeAcknowledged: true,
      exactSQLAcknowledgment: true,
      transportOccupied: false,
      usageRecorded: true,
      requestedModel,
      usageModel: observation.model,
      terminalWithheldUntilDurable: true,
      occupied: 0,
      open: 0,
      unresolvedCleanup: 0,
      executionClosed: true,
      cleanupDone: true,
    };
  }
  await controlLimits("/limits/tombstone");
  assert.deepEqual(
    await limitsClient.readAccountLimits(limitsInput),
    { status: "unavailable" },
    "native tombstone cannot resurrect cached values",
  );
  assert.deepEqual(await stats(), final, "all cached reads made zero provider requests");
  child.stdin!.end("stop\n");
  stopped = true;
  const closed = await next("closed");
  assert.equal(closed.plaintextCredentials, 0);
  assert.equal(closed.retainedDeviceMaterial, 0);
  assert.equal(await bounded(childExit), 0);
  if (!cliBinary) assert.equal(diagnostic, "");
  phase = "completed";
  const receipt = {
    phase,
    contract: "gateway-native-device-joined/v1",
    nativeBinarySHA256: binarySHA256,
    nativeHead,
    gatewayHead,
    sourceHashes,
    nativeHTTP: true,
    gatewayFacadeAndSDK: true,
    liveOwnerCallback: true,
    actualPostgreSQL: true,
    handoffFreshOnly: true,
    wrongOwnerDenied: true,
    account: "active",
    descriptor: "verified",
    rrAcceptance,
    accountLimits: {
      cachedRead: true,
      snapshotUsedPercent: 37.5,
      missingUnknown: true,
      nativeTombstoneUnavailable: true,
      renamePreserved: true,
      upstreamCalls: 0,
    },
    provider: final,
    plaintextCredentials: 0,
    retainedDeviceMaterial: 0,
    inferenceRequests: cliBinary ? 1 : 0,
    ...(cliEvidence ? { actualCLI: cliEvidence, nativeDiagnosticBytes } : {}),
  };
  await writeFile(join(scratch, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  report({ ...receipt, receiptPath: join(scratch, "receipt.json") });
}
try {
  await run();
} catch (error) {
  const frame =
    error instanceof Error
      ? /native-device-joined\.ts:(\d+):(\d+)/.exec(
          error.stack
            ?.split("\n")
            .slice(1)
            .find((line) => /^\s+at /.test(line) && line.includes("/native-device-joined.ts:")) ??
            "",
        )
      : undefined;
  report({
    phase: "failed",
    at: phase,
    code: error instanceof assert.AssertionError ? "assertion_failed" : "qualification_failed",
    ...(error instanceof assert.AssertionError
      ? { actualType: typeof error.actual, expectedType: typeof error.expected }
      : {}),
    ...(frame ? { frame: "native-device-joined.ts:" + frame[1] + ":" + frame[2] } : {}),
  });
  process.exitCode = 1;
} finally {
  releaseTerminalUsage?.();
  if (cliChild?.pid) {
    try {
      process.kill(-cliChild.pid, "SIGKILL");
    } catch {}
  }
  if (child && !Object.is(stopped, true)) {
    child.stdin!.end("stop\n");
  }
  if (childExit) {
    await bounded(childExit, 5000).catch(() => {
      child?.kill("SIGTERM");
    });
  }
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
