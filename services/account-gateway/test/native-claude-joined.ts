// Explicit controlled joint E2E: real public SDK/facade/management/native client,
// real Go native HTTP/service/repository/custody/descriptor and two fresh PG17 DBs.
// The Go fixture owns a local TLS Claude-shaped provider; no live account access.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
import { claudeOAuthProfile } from "../src/management.ts";
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
let cliProcess: ReturnType<typeof spawn> | undefined;
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

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function run(): Promise<void> {
  assert.equal(process.env.AG_NATIVE_CLAUDE_JOINED_ALLOW, "disposable_pg17_10");
  const cliBinary = process.env.AG_NATIVE_CLAUDE_JOINED_CLI_BINARY;
  let clientPin: { version: string; binarySHA256: string } | undefined;
  let networkNamespace: string | undefined;
  if (cliBinary !== undefined) {
    phase = "pinned-client-and-network";
    assert.ok(isAbsolute(cliBinary));
    const pins = JSON.parse(
      await readFile(new URL("./fixtures/native-cli/pins.json", import.meta.url), "utf8"),
    ) as { clients: { id: string; version: string; binarySHA256: string }[] };
    clientPin = pins.clients.find((p) => p.id === "claude");
    assert.ok(clientPin);
    assert.equal(clientPin.version, "2.1.309");
    assert.equal(
      createHash("sha256")
        .update(await readFile(cliBinary))
        .digest("hex"),
      clientPin.binarySHA256,
    );
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
  const nativeDSN = disposable("AG_NATIVE_CLAUDE_JOINED_NATIVE_DSN", "native_claude_joined_");
  const kernelDSN = disposable(
    "AG_NATIVE_CLAUDE_JOINED_KERNEL_DSN",
    "ag_kernel_test_claude_joined_",
  );
  phase = "native-binary-input";
  const binary = process.env.AG_NATIVE_CLAUDE_JOINED_BINARY;
  assert.ok(
    binary !== undefined &&
      binary !== "" &&
      isAbsolute(binary) &&
      binary.includes("/tmp/native-claude-joined/"),
  );
  const binarySHA256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  phase = "native-build-provenance";
  const buildInfo = execFileSync(
    process.env.AG_NATIVE_CLAUDE_JOINED_GO ?? "go",
    ["version", "-m", binary],
    { encoding: "utf8", timeout: 5000, maxBuffer: 131072 },
  );
  const nativeHead = /vcs\.revision=([a-f0-9]{40})/.exec(buildInfo)?.[1];
  assert.ok(nativeHead !== undefined && nativeHead !== "");
  if (cliBinary !== undefined) {
    assert.match(process.env.AG_NATIVE_CLAUDE_JOINED_NATIVE_COMMIT ?? "", /^[a-f0-9]{40}$/);
    assert.equal(nativeHead, process.env.AG_NATIVE_CLAUDE_JOINED_NATIVE_COMMIT);
  }
  phase = "native-clean-build-provenance";
  assert.match(buildInfo, /vcs\.modified=false/);
  phase = "gateway-source-provenance";
  const gatewayRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const gatewayHead =
    cliBinary !== undefined
      ? (process.env.AG_NATIVE_CLAUDE_JOINED_GATEWAY_COMMIT ?? "")
      : execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: gatewayRoot,
          encoding: "utf8",
          timeout: 5000,
        }).trim();
  assert.match(gatewayHead, /^[a-f0-9]{40}$/);
  const sourceHashes = {
    harness: await sha256(new URL(import.meta.url)),
    nativeFixture: await sha256(
      new URL("./fixtures/native-claude-joined/main.go", import.meta.url),
    ),
    sdkHTTP: await sha256(new URL(import.meta.resolve("@agent-teams/account-gateway/http"))),
  };
  const consumerId = "joined-claude-" + randomUUID(),
    ownerRef = "joined-claude-owner";
  const managementCredential = randomBytes(32).toString("base64url"),
    callbackCredential = randomBytes(32).toString("base64url");
  phase = "gateway-scratch";
  const scratchRoot =
    process.env.AG_NATIVE_CLAUDE_JOINED_SCRATCH_ROOT ??
    resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../tmp");
  assert.ok(isAbsolute(scratchRoot));
  if (cliBinary !== undefined)
    assert.ok(
      process.env.AG_NATIVE_CLAUDE_JOINED_SCRATCH_ROOT,
      "CLI mode requires task-owned scratch",
    );
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, "native-claude-joined-"));
  const configFile = join(scratch, "native-config.json");
  const nativeExecution = randomBytes(32).toString("base64url"),
    nativeCleanup = randomBytes(32).toString("base64url");
  await writeFile(
    configFile,
    JSON.stringify({
      DSN: nativeDSN,
      Consumer: consumerId,
      Control: managementCredential,
      Callback: callbackCredential,
      Execution: nativeExecution,
      Cleanup: nativeCleanup,
      CLI: cliBinary !== undefined,
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
  let diagnostic = Buffer.alloc(0),
    nativeDiagnosticBytes = 0;
  child.stderr!.on("data", (bytes: Buffer) => {
    nativeDiagnosticBytes += bytes.byteLength;
    if (diagnostic.byteLength < 8192) {
      diagnostic = Buffer.concat([diagnostic, bytes.subarray(0, 8192 - diagnostic.byteLength)]);
    }
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
  phase = "kernel-database-guard";
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
  phase = "kernel-migrations";
  const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .toSorted();
  assert.ok(migrations.length > 0);
  for (const name of migrations) {
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
    requestBytes: cliBinary ? 1 << 20 : 4096,
    outputBytes: cliBinary ? 1 << 20 : 4096,
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
    profileIds: [claudeOAuthProfile.profile],
    preparation: {
      accountRefs: [],
      subjectRef: "joined-claude-policy",
      policyRevision: 1,
      bindingRevision: 1,
      profileId: claudeOAuthProfile.profile,
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
      originRef: "joined-claude-origin",
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
      qualificationRef: "joined-claude-unused-apikey",
      limits,
      providerTokenUpperBound: limits.tokens,
    },
    claudeOAuthEnrollment: {
      enabled: true,
      profile: "anthropic-claude-oauth-messages-v1",
      modelScope: ["claude-sonnet-4-6"],
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
        profileIds: [claudeOAuthProfile.profile],
        limits,
        maxRunMs: 60_000,
      },
    ],
  } satisfies Pick<
    ServiceConfig,
    "native" | "consumer" | "profile" | "claudeOAuthEnrollment" | "bearers"
  >;
  const control = composeServiceControl(cfg, kernel, store, secrets, worker);
  const enrollment = { originRef: cfg.native.originRef, engineIncarnation: randomUUID(), worker };
  const usage = new PostgresUsageJournal(pool, randomBytes(32));
  const terminalUsage = Promise.withResolvers<void>(),
    allowTerminalUsage = Promise.withResolvers<void>();
  releaseTerminalUsage = () => allowTerminalUsage.resolve();
  let terminalUsageWrites = 0;
  const gatedUsage: UsageJournal = {
    observe: (...args) => usage.observe(...args),
    list: (...args) => usage.list(...args),
    async append(ctx, fact) {
      if (fact.completeness === "complete") {
        terminalUsageWrites++;
        terminalUsage.resolve();
        await allowTerminalUsage.promise;
      }
      await usage.append(ctx, fact);
    },
  };
  const { authority, transport } = composeServiceNative(
    cfg,
    control,
    kernel,
    store,
    enrollment,
    cliBinary ? gatedUsage : undefined,
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
      ...(cliBinary ? { usage: gatedUsage } : {}),
    }),
  );
  child.stdin!.write(
    JSON.stringify({
      callbackOrigin,
      originRef: enrollment.originRef,
      engineIncarnation: enrollment.engineIncarnation,
      qualificationRef: control.profiles[0].qualificationRef,
    }) + "\n",
  );
  const configured = await next("configured");
  if (cliBinary) {
    assert.equal(typeof configured.inferenceOrigin, "string");
    const url = new URL(configured.inferenceOrigin as string);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(url.port);
  }
  const client = createManagementClient({ role: "management", origin, token: publicToken });
  const foreign = createManagementClient({ role: "management", origin, token: foreignToken });
  const command = {
    operationId: randomUUID(),
    ownerRef,
    profileId: claudeOAuthProfile.profile,
    displayName: "Controlled joined Claude",
  };
  const stats = async (): Promise<Record<string, number>> => {
    const response = await fetch(ready.controllerOrigin + "/stats", {
      headers: { authorization: "Bearer " + managementCredential },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, number>;
  };
  phase = "fresh-browser-handoff";
  const begun = await client.beginOAuth(command);
  assert.equal(begun.operation.state, "pending");
  assert.ok(isNonemptyString(begun.authorizationURL));
  assert.equal(begun.deviceAuthorization, undefined);
  const authorization = new URL(begun.authorizationURL);
  assert.equal(authorization.origin, "https://claude.com");
  assert.equal(authorization.pathname, "/cai/oauth/authorize");
  const state = authorization.searchParams.get("state");
  assert.match(state ?? "", /^[a-f0-9]{64}$/);
  const journal = await store.readJournal(context, command.operationId);
  assert.ok(journal);
  assert.equal((await client.get(journal.accountRef)).state, "staging");
  assert.equal((await client.beginOAuth(command)).authorizationURL, undefined);
  assert.equal((await client.readOAuth(command.operationId)).state, "pending");
  assert.deepEqual(await stats(), { exchanges: 0, refreshes: 0, messages: 0, unexpected: 0 });
  const complete = {
    operationId: command.operationId,
    ownerRef,
    authorizationCode: "fixture-code#" + state,
  };
  phase = "owner-and-method-boundary";
  await assert.rejects(foreign.completeOAuth(complete), denied);
  await assert.rejects(
    client.completeOAuth({ ...complete, ownerRef: "joined-foreign-owner" }),
    denied,
  );
  await assert.rejects(
    client.beginOAuth({ ...command, operationId: randomUUID(), method: "device_code" }),
    denied,
  );
  const wrongShape = await fetch(origin + "/v1/accounts/oauth/complete", {
    method: "POST",
    headers: {
      authorization: "Bearer " + publicToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      operationId: command.operationId,
      ownerRef,
      callbackURL: "http://localhost:1455/auth/callback?code=fixture-code&state=" + state,
    }),
  });
  assert.equal(wrongShape.status, 400);
  await wrongShape.arrayBuffer();
  assert.deepEqual(await stats(), { exchanges: 0, refreshes: 0, messages: 0, unexpected: 0 });
  phase = "authorized-native-custody-and-descriptor";
  const applied = await client.completeOAuth(complete);
  assert.equal(applied.state, "applied");
  assert.equal((await client.get(journal.accountRef)).state, "active");
  const mapping = await store.mapping(context, journal.generation);
  assert.ok(mapping);
  assert.equal(mapping.descriptor.generation, journal.generation);
  assert.equal(mapping.descriptor.profile, claudeOAuthProfile.profile);
  assert.equal(mapping.descriptor.model, "claude-sonnet-4-6");
  assert.equal(mapping.descriptor.nativePhysicalIdentity, journal.generation);
  assert.ok(mapping.descriptor.nativeId > 0);
  assert.deepEqual(await client.completeOAuth(complete), applied);
  assert.equal((await client.readOAuth(command.operationId)).state, "applied");
  assert.deepEqual(await client.beginOAuth(command), { operation: applied });
  const beforeInference = await stats();
  assert.deepEqual(beforeInference, { exchanges: 1, refreshes: 0, messages: 0, unexpected: 0 });
  assert.equal(
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ag_management.transient_intents WHERE consumer=$1",
        [consumerId],
      )
    ).rows[0].n,
    0,
  );
  phase = "missing-cached-limits";
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
    profileId: claudeOAuthProfile.profile,
    expectedAuthorizationEpoch: (await kernel.account(context, journal.accountRef)).epoch,
  };
  assert.deepEqual(await limitsClient.readAccountLimits(limitsInput), { status: "unknown" });
  await assert.rejects(
    limitsClient.readAccountLimits({ ...limitsInput, ownerRef: "joined-foreign-owner" }),
    denied,
  );
  assert.deepEqual(
    await stats(),
    beforeInference,
    "cached read never logs in, refreshes or sends Messages",
  );
  phase = "actual-messages-dispatch-produces-observation";
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
    subjectRef: "joined-claude-policy",
    policyRevision: 1,
    bindingRevision: 1,
    profileId: claudeOAuthProfile.profile,
    limits,
    deadline: new Date(Date.now() + 30_000).toISOString(),
  });
  const execution = createExecutionClient({ role: "execution", origin, token: access.bearer });
  if (access.operation.state !== "applied" || access.operation.result?.kind !== "execution")
    throw new Error("missing execution authority");
  const executionRef = access.operation.result.executionRef;
  let cliProof:
    | {
        terminalWaitedForDurability: boolean;
        nativeClosureVerified: boolean;
        executionCleanupCompleted: boolean;
      }
    | undefined;
  if (cliBinary) {
    phase = "real-cli-public-authority";
    const inferenceOrigin = configured.inferenceOrigin as string;
    const wrongRole = await fetch(inferenceOrigin + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": publicToken, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: true,
        max_tokens: 1,
        messages: [{ role: "user", content: "Controlled wrong-role refusal" }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(wrongRole.status, 403);
    await wrongRole.arrayBuffer();
    assert.deepEqual(await stats(), beforeInference);
    const project = join(scratch, "empty-project");
    await mkdir(project, { mode: 0o700 });
    cliProcess = spawn(
      cliBinary,
      [
        "--bare",
        "-p",
        "--model",
        "claude-sonnet-4-6",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--no-session-persistence",
        "--system-prompt",
        "Controlled local protocol fixture.",
        "Return the local fixture answer.",
      ],
      {
        cwd: project,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          ANTHROPIC_BASE_URL: inferenceOrigin,
          ANTHROPIC_API_KEY: access.bearer,
          CLAUDE_CONFIG_DIR: join(scratch, "claude-config"),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        },
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      overflow = false,
      exited = false;
    const killClient = () => {
      if (!exited && cliProcess?.pid) {
        try {
          process.kill(-cliProcess.pid, "SIGKILL");
        } catch {}
      }
    };
    cliProcess.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1 << 20) {
        overflow = true;
        killClient();
      } else stdout.push(chunk);
    });
    cliProcess.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1 << 20) {
        overflow = true;
        killClient();
      }
    });
    const clientExit = new Promise<number | null>((resolve) => {
      cliProcess!.once("error", () => resolve(-1));
      cliProcess!.once("close", (code) => {
        exited = true;
        resolve(code);
      });
    });
    const timer = setTimeout(killClient, 70_000);
    const clientResults = () =>
      Buffer.concat(stdout)
        .toString("utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            const frame: unknown = JSON.parse(line);
            return frame && typeof frame === "object" ? [frame as Record<string, unknown>] : [];
          } catch {
            return [];
          }
        });
    try {
      await bounded(
        Promise.race([
          terminalUsage.promise,
          clientExit.then(() => {
            throw new Error("client-ended-before-terminal-usage");
          }),
        ]),
        25_000,
      );
      phase = "terminal-withheld-before-real-usage-and-ack";
      const pending = (
        await pool.query(
          `SELECT id,effect,transport_occupied,closure_acked_at FROM ag_kernel.requests
        WHERE consumer=$1 AND execution_ref=$2`,
          [consumerId, executionRef],
        )
      ).rows;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].effect, "completed");
      assert.equal(pending[0].transport_occupied, true);
      assert.equal(pending[0].closure_acked_at, null);
      const requestRef = pending[0].id as string,
        originalProof = await kernel.requestProof(context, executionRef, requestRef);
      assert.ok(originalProof);
      assert.equal(originalProof.worker, worker);
      assert.equal(originalProof.native?.generation, journal.generation);
      assert.equal(
        (await usage.observe(context, executionRef, requestRef))?.completeness === "complete",
        false,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(exited, false);
      assert.equal(
        clientResults().some((frame) => frame.type === "result"),
        false,
      );
      releaseTerminalUsage();
      assert.equal(await bounded(clientExit, 20_000), 0);
      assert.equal(overflow, false);
      const complete = clientResults().filter((frame) => frame.type === "result");
      assert.equal(complete.length, 1);
      assert.equal(complete[0].subtype, "success");
      assert.equal(complete[0].is_error, false);
      assert.equal(
        typeof complete[0].result === "string" &&
          complete[0].result.includes("joined Claude answer"),
        true,
      );
      phase = "real-durable-terminal-usage-and-physical-closure";
      const finalRequest = (
        await pool.query(
          `SELECT effect,transport_occupied,closure_acked_at FROM ag_kernel.requests
        WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
          [consumerId, executionRef, requestRef],
        )
      ).rows[0];
      assert.equal(finalRequest.effect, "completed");
      assert.equal(finalRequest.transport_occupied, false);
      assert.ok(finalRequest.closure_acked_at);
      assert.deepEqual(await kernel.requestProof(context, executionRef, requestRef), originalProof);
      const fact = await usage.observe(context, executionRef, requestRef);
      assert.ok(fact);
      assert.equal(fact.completeness, "complete");
      assert.equal(fact.effect, "completed");
      assert.equal(fact.revision, 2);
      assert.equal(fact.inputTokens, 7);
      assert.equal(fact.outputTokens, 3);
      assert.equal(terminalUsageWrites, 1);
      const response = await fetch(
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
      assert.equal(response.status, 202);
      const closed = nativeReceipt(await response.json(), consumerId, originalProof);
      assert.equal(
        physicallyClosed(closed) &&
          closed.acknowledged &&
          closed.lifetime.completed &&
          closed.lifetime.entered,
        true,
      );
      phase = "real-execution-cleanup";
      const close = { operationId: randomUUID(), reason: "completed" as const };
      await execution.close(executionRef, close);
      const cleanup = await kernel.claimCleanup(context, worker);
      assert.ok(cleanup && cleanup.scope.kind === "execution");
      assert.equal(cleanup.scope.executionRef, executionRef);
      assert.equal(cleanup.scope.transports.length, 0);
      await kernel.settleCleanup(context, cleanup.cleanupRef, worker, cleanup.token, true);
      assert.equal((await execution.close(executionRef, close)).state, "applied");
      assert.equal((await kernel.savedExecution(context, executionRef)).state, "closed");
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2 AND state<>'done'`,
            [consumerId, executionRef],
          )
        ).rows[0].n,
        0,
      );
      const afterClose = await fetch(inferenceOrigin + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": access.bearer, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: true,
          max_tokens: 1,
          messages: [{ role: "user", content: "Controlled closed execution refusal" }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(afterClose.status, 403);
      await afterClose.arrayBuffer();
      cliProof = {
        terminalWaitedForDurability: true,
        nativeClosureVerified: true,
        executionCleanupCompleted: true,
      };
    } finally {
      clearTimeout(timer);
      releaseTerminalUsage();
      killClient();
      cliProcess = undefined;
    }
  } else {
    const requestRef = randomUUID();
    const result = await execution.request(executionRef, {
      requestId: requestRef,
      admission: access.admission,
      body: Buffer.from(
        JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: true,
          store: false,
          service_tier: "default",
          max_output_tokens: 100,
          instructions: "Controlled fixture system instructions stay at system priority.",
          input: "Controlled disposable fixture",
        }),
      ),
    });
    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") throw new Error("missing controlled stream");
    const reader = result.body.getReader();
    let stream = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      stream += new TextDecoder().decode(part.value);
    }
    assert.match(stream, /response.completed/);
  }
  const final = await stats();
  assert.deepEqual(final, { exchanges: 1, refreshes: 0, messages: 1, unexpected: 0 });
  phase = "passive-cached-limits";
  const snapshot = await limitsClient.readAccountLimits(limitsInput);
  assert.equal(snapshot.status, "snapshot");
  if (!Object.is(snapshot.status, "snapshot")) {
    throw new Error("missing controlled snapshot");
  }
  assert.equal(snapshot.physicalGeneration, journal.generation);
  assert.match(snapshot.principalVersion, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.scope, "account");
  assert.deepEqual(
    snapshot.windows.map((w) => ({
      id: w.id,
      family: w.family,
      duration: w.durationSeconds,
      used: w.usedPercent,
    })),
    [
      { id: "claude-5h", family: "claude", duration: 18000, used: 37.5 },
      { id: "claude-7d", family: "claude", duration: 604800, used: 62.5 },
    ],
  );
  let rrAcceptance = false;
  const rrModule = process.env.AG_NATIVE_CLAUDE_JOINED_RR_ACCEPTANCE_MODULE;
  if (rrModule !== undefined) {
    assert.ok(isAbsolute(rrModule) && rrModule.endsWith(".mts"));
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
        displayName: "Renamed controlled Claude",
      })
    ).state,
    "applied",
  );
  assert.deepEqual(await limitsClient.readAccountLimits(limitsInput), snapshot);
  assert.deepEqual(
    await stats(),
    final,
    "cached page rendering and rename make zero provider calls",
  );
  const tombstone = await fetch(ready.controllerOrigin + "/limits/tombstone", {
    method: "POST",
    headers: {
      authorization: "Bearer " + managementCredential,
      "content-type": "application/json",
    },
    body: JSON.stringify(limitsInput),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(tombstone.status, 204);
  await tombstone.arrayBuffer();
  assert.deepEqual(await limitsClient.readAccountLimits(limitsInput), { status: "unavailable" });
  assert.deepEqual(await stats(), final);
  phase = "native-close";
  child.stdin!.end("stop\n");
  stopped = true;
  const closed = await next("closed");
  assert.equal(closed.plaintextCredentials, 0);
  assert.equal(closed.retainedOAuthMaterial, 0);
  assert.equal(await bounded(childExit), 0);
  phase = "completed";
  const receipt = {
    phase,
    contract: "gateway-native-claude-joined/v1",
    nativeBinarySHA256: binarySHA256,
    nativeHead,
    gatewayHead,
    sourceHashes,
    nativeHTTP: true,
    gatewayFacadeAndSDK: true,
    liveOwnerCallback: true,
    actualPostgreSQL: true,
    browserFreshOnly: true,
    wrongOwnerDenied: true,
    deviceDenied: true,
    account: "active",
    descriptor: "verified",
    ...(cliBinary
      ? {
          actualCLI: {
            id: "claude",
            version: clientPin!.version,
            binarySHA256: clientPin!.binarySHA256,
            exitCode: 0,
            providerEntries: final.messages,
            sqlEffect: "completed",
            nativeClosed: true,
            nativeAcknowledged: true,
            transportOccupied: false,
            usageRecorded: true,
            executionClosed: true,
            protocol: "Anthropic Messages HTTP/SSE",
            authority: "real TypeScript kernel and native authority",
            usage: "real PostgreSQL usage journal",
            networkNamespace,
            ...cliProof,
          },
        }
      : {}),
    rrAcceptance,
    nativeDiagnosticBytes,
    accountLimits: {
      cachedRead: true,
      passiveMessagesProducer: true,
      missingUnknown: true,
      nativeTombstoneUnavailable: true,
      renamePreserved: true,
      upstreamCallsForRead: 0,
    },
    provider: final,
  };
  await writeFile(join(scratch, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  report({ ...receipt, receiptPath: join(scratch, "receipt.json") });
}
try {
  await run();
} catch (error) {
  const frame =
    error instanceof Error
      ? /native-claude-joined\.ts:(\d+):(\d+)/.exec(
          error.stack
            ?.split("\n")
            .slice(1)
            .find((line) => /^\s+at /.test(line) && line.includes("/native-claude-joined.ts:")) ??
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
    ...(frame ? { frame: "native-claude-joined.ts:" + frame[1] + ":" + frame[2] } : {}),
  });
  process.exitCode = 1;
} finally {
  releaseTerminalUsage?.();
  if (cliProcess?.pid && cliProcess.exitCode === null && cliProcess.signalCode === null) {
    try {
      process.kill(-cliProcess.pid, "SIGKILL");
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
