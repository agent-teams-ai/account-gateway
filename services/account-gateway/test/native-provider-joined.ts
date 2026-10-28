// Explicit controlled joint E2E: real public SDK/facade/management/native client,
// real Go native HTTP/service/repository/custody/descriptor and two fresh PG17 DBs.
// The Go fixture owns a local TLS provider-shaped provider; no live account access.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import pg from "pg";
import {
  createAccountLimitsV2Client,
  createManagementClient,
  createConsumerControlClient,
  createExecutionClient,
  GatewayError,
} from "@agent-teams/account-gateway/http";
import { PostgresKernel } from "../src/postgres.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { openRouterProfile, kimiProfile, glmProfile, minimaxProfile } from "../src/service-config.ts";
import { grokOAuthProfile } from "../src/oauth-profiles.ts";
import {
  composeServiceControl,
  composeServiceNative,
  composeServiceCachedLimits,
  composeServiceCleanupClaim,
} from "../src/service.ts";
import { createFacade, cancelFacadeTransport } from "../src/facade.ts";
import type { FacadeOptions } from "../src/facade.ts";
import type { ServiceConfig } from "../src/service-config.ts";

const report = (value: object): void => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
let phase = "guard";
const servers: Server[] = [];
let pool: pg.Pool | undefined;
let child: ReturnType<typeof spawn> | undefined;
let stopped = false;
let childExit: Promise<number | null> | undefined;
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}
async function bounded<T>(work: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("controlled joined timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function disposable(name: string, prefix: string): string {
  const raw = process.env[name];
  assert.ok(raw);
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
async function run(): Promise<void> {
  assert.equal(process.env.AG_NATIVE_PROVIDER_JOINED_ALLOW, "disposable_pg17_10");
  const nativeDSN = disposable("AG_NATIVE_PROVIDER_JOINED_NATIVE_DSN", "native_provider_joined_");
  const kernelDSN = disposable(
    "AG_NATIVE_PROVIDER_JOINED_KERNEL_DSN",
    "ag_kernel_test_provider_joined_",
  );
  phase = "native-binary-input";
  const binary = process.env.AG_NATIVE_PROVIDER_JOINED_BINARY;
  assert.ok(binary && isAbsolute(binary) && binary.includes("/tmp/native-provider-joined/"));
  const binarySHA256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  phase = "native-build-provenance";
  const buildInfo = execFileSync(
    process.env.AG_NATIVE_PROVIDER_JOINED_GO ?? "go",
    ["version", "-m", binary],
    { encoding: "utf8", timeout: 5000, maxBuffer: 131072 },
  );
  const nativeHead = /vcs\.revision=([a-f0-9]{40})/.exec(buildInfo)?.[1];
  assert.ok(nativeHead);
  assert.match(
    buildInfo,
    /(?:^|\s)vcs\.modified=false(?:\s|$)/,
    "native binary must come from clean committed source",
  );
  phase = "gateway-source-provenance";
  const gatewayRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const gatewayHead =
    process.env.AG_NATIVE_PROVIDER_JOINED_GATEWAY_BASE_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gatewayRoot,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  assert.match(gatewayHead, /^[a-f0-9]{40}$/);
  const gatewaySourceArchiveSHA256 = process.env.AG_NATIVE_PROVIDER_JOINED_GATEWAY_SOURCE_SHA256;
  if (gatewaySourceArchiveSHA256 !== undefined)
    assert.match(gatewaySourceArchiveSHA256, /^[a-f0-9]{64}$/);
  const sha256 = async (url: URL): Promise<string> =>
    createHash("sha256")
      .update(await readFile(url))
      .digest("hex");
  const sourceHashes = {
    harness: await sha256(new URL(import.meta.url)),
    nativeFixture: await sha256(
      new URL("./fixtures/native-provider-joined/main.go", import.meta.url),
    ),
    sdkHTTP: await sha256(new URL(import.meta.resolve("@agent-teams/account-gateway/http"))),
  };
  const consumerId = "joined-provider-" + randomUUID(),
    ownerRef = "joined-provider-owner";
  const managementCredential = randomBytes(32).toString("base64url"),
    callbackCredential = randomBytes(32).toString("base64url");
  phase = "gateway-scratch";
  const scratchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tmp");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, "native-provider-joined-"));
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
    }),
    { mode: 0o600 },
  );
  phase = "native-start";
  child = spawn(binary, [configFile], {
    env: { GIN_MODE: "release" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin!.on("error", () => undefined);
  // Native diagnostics are retained privately, never reflected into public results.
  let diagnostic = Buffer.alloc(0),
    nativeDiagnosticBytes = 0;
  child.stderr!.on("data", (bytes: Buffer) => {
    nativeDiagnosticBytes += bytes.byteLength;
    if (diagnostic.byteLength < 8192)
      diagnostic = Buffer.concat([diagnostic, bytes.subarray(0, 8192 - diagnostic.byteLength)]);
  });
  childExit = new Promise((resolve) => {
    child!.once("error", () => resolve(-1));
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
  pool = new pg.Pool({
    connectionString: kernelDSN,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  pool.on("error", () => undefined);
  const version = (
    await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")
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
    .sort();
  assert.ok(migrations.length > 0);
  for (const name of migrations)
    await pool.query(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const kernel = new PostgresKernel(pool),
    secrets = new IntentSecrets(randomBytes(32), randomBytes(32));
  const store = new PostgresManagementStore(pool, secrets),
    worker = randomUUID(),
    context = { consumerId };
  await kernel.issuer(context);
  await kernel.heartbeat(context, worker);
  const limits = {
    requests: 12,
    concurrency: 1,
    requestBytes: 1048576,
    outputBytes: 8388608,
    tokens: 32768,
  };
  const publicToken = randomBytes(32).toString("base64url"),
    consumerToken = randomBytes(32).toString("base64url");
  const foreignToken = randomBytes(32).toString("base64url");
  const tuples = [kimiProfile, glmProfile, minimaxProfile, grokOAuthProfile];
  const qualified = tuples.map((tuple) => ({
    ...tuple,
    qualificationRef: "controlled-source-v1",
    limits,
    providerTokenUpperBound: 32768,
  }));
  const openRouterEnrollment = { ...openRouterProfile, model: "birth/anchor", qualificationRef: "controlled-source-v1", limits, providerTokenUpperBound: 32768 };
  const profileIds = [...tuples.map((tuple) => tuple.profile), openRouterEnrollment.profile];
  const bearer = (token: string, owner: string) => ({
    token,
    role: "management" as const,
    consumerId,
    ownerRefs: [owner],
    profileIds,
    preparation: {
      accountRefs: [],
      subjectRef: "joined-provider-policy",
      policyRevision: 1,
      bindingRevision: 1,
      profileId: grokOAuthProfile.profile,
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
      originRef: "joined-provider-origin",
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
      qualificationRef: "joined-provider-unused",
      limits,
      providerTokenUpperBound: 32768,
    },
    secondProfile: openRouterEnrollment,
    providerProfiles: qualified.slice(0, 3),
    grokOAuthEnrollment: {
      enabled: true,
      profile: "grok-subscription-responses-oauth-v1",
      modelScope: ["grok-4.7"],
      qualificationRef: "controlled-source-v1",
      limits,
      providerTokenUpperBound: 32768,
      deploymentQualified: true,
      clientId: "joined-provider-client",
      authorizationOrigin: "https://auth.x.ai",
      redirectPolicy: "manual_loopback",
      redirectURI: "http://127.0.0.1:56121/callback",
    },
    bearers: [
      bearer(publicToken, ownerRef),
      bearer(foreignToken, "joined-provider-foreign"),
      {
        token: consumerToken,
        role: "consumer-control",
        consumerId,
        profileIds,
        limits,
        maxRunMs: 60_000,
      },
    ],
  } satisfies Pick<
    ServiceConfig,
    "native" | "consumer" | "profile" | "secondProfile" | "providerProfiles" | "grokOAuthEnrollment" | "bearers"
  >;
  phase = "gateway-control-composition";
  const control = composeServiceControl(cfg, kernel, store, secrets, worker);
  const enrollment = { originRef: cfg.native.originRef, engineIncarnation: randomUUID(), worker };
  phase = "gateway-native-composition";
  const { authority, transport } = composeServiceNative(cfg, control, kernel, store, enrollment);
  const callbackOrigin = await listen(authority.createServer());
  const facadeOptions = {
    kernel,
    store,
    management: control.management,
    bearers: control.bearers,
    profiles: control.catalog,
    enrollment,
    transport,
    ...composeServiceCachedLimits(control),
    intentHmacKey: randomBytes(32),
  } satisfies FacadeOptions;
  const origin = await listen(createFacade(facadeOptions));
  child.stdin!.write(
    JSON.stringify({
      callbackOrigin,
      originRef: enrollment.originRef,
      engineIncarnation: enrollment.engineIncarnation,
      qualificationRef: control.profiles[0].qualificationRef,
    }) + "\n",
  );
  await next("configured");
  const client = createManagementClient({ role: "management", origin, token: publicToken, responseBytes: 2 * 1024 * 1024 });
  const foreign = createManagementClient({ role: "management", origin, token: foreignToken });
  const consumer = createConsumerControlClient({
    role: "consumer-control",
    origin,
    token: consumerToken,
    responseBytes: 2 * 1024 * 1024,
  });
  const limitsClient = createAccountLimitsV2Client({
    role: "consumer-control",
    origin,
    token: consumerToken,
    contract: "account-limits/v2",
  });
  type ProviderStats = {
    dispatches: number;
    quotaGets: number;
    exchanges?: number;
    refreshes?: number;
    functionCalls: number;
    functionOutputs: number;
    customCalls: number;
    customOutputs: number;
  };
  type Stats = Record<"kimi" | "glm" | "minimax" | "grok" | "openrouter", ProviderStats> & { unexpected: number; openrouterModelGets: number };
  const controller = async (path: string, value?: unknown): Promise<Response> =>
    fetch(ready.controllerOrigin + path, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + managementCredential,
        ...(value === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(5000),
    });
  const stats = async (): Promise<Stats> => {
    const response = await controller("/stats");
    assert.equal(response.status, 200);
    return (await response.json()) as Stats;
  };
  const denied = (error: unknown): boolean =>
    error instanceof GatewayError && error.diagnostic?.code === "forbidden";
  phase = "safe-source-capabilities";
  const capabilities = await consumer.getProviderConnectionCapabilities();
  assert.deepEqual(
    capabilities.capabilities.map((capability) => capability.profileId).sort(),
    [...profileIds].sort(),
  );
  assert.equal(
    capabilities.capabilities.filter((capability) => capability.profileId !== openRouterEnrollment.profile).every(
      (capability) => capability.limitsContract === "account-limits/v2",
    ),
    true,
  );
  assert.deepEqual(await limitsClient.getAccountLimitsCapabilities(), {
    contract: "account-limits/v2",
    cachedRead: true,
    quotaOnlyRefresh: false,
  });
  const accounts: {
    provider: "kimi" | "glm" | "minimax" | "grok";
    tuple: (typeof tuples)[number];
    accountRef: string;
    generation: string;
  }[] = [];
  for (const [index, tuple] of tuples.entries()) {
    const provider = (["kimi", "glm", "minimax", "grok"] as const)[index];
    phase = provider + "-protected-enrollment";
    const command = {
      operationId: randomUUID(),
      ownerRef,
      profileId: tuple.profile,
      displayName: "Controlled " + provider,
    };
    let applied;
    if (provider === "grok") {
      await assert.rejects(
        client.beginOAuth({ ...command, operationId: randomUUID(), method: "device_code" }),
        denied,
      );
      const begun = await client.beginOAuth(command);
      assert.ok(begun.authorizationURL);
      assert.equal(begun.operation.state, "pending");
      assert.equal(new URL(begun.authorizationURL).origin, "https://auth.x.ai");
      const response = await controller("/grok/authorize", {
        authorizeUrl: begun.authorizationURL,
      });
      assert.equal(response.status, 200);
      const callback = (await response.json()) as { state: string; code: string };
      const completion = {
        operationId: command.operationId,
        ownerRef,
        callbackURL: "http://127.0.0.1:56121/callback?" + new URLSearchParams(callback),
      };
      await assert.rejects(foreign.completeOAuth(completion), denied);
      applied = await client.completeOAuth(completion);
      assert.deepEqual(await client.completeOAuth(completion), applied);
      assert.equal((await client.readOAuth(command.operationId)).state, "applied");
      assert.equal((await client.beginOAuth(command)).authorizationURL, undefined);
    } else {
      const keyCommand = {
        ...command,
        credential: { kind: "api_key" as const, value: "fixture-provider-key-" + provider },
      };
      applied = await client.connect(keyCommand);
      assert.deepEqual(await client.connect(keyCommand), applied);
    }
    assert.equal(applied.state, "applied");
    if (applied.state !== "applied" || applied.result?.kind !== "account")
      throw new Error("missing account");
    const account = await client.get(applied.result.accountRef);
    assert.equal(account.state, "active");
    const journal = await store.readJournal(context, command.operationId);
    assert.ok(journal);
    const mapping = await store.mapping(context, journal.generation);
    assert.ok(mapping);
    assert.equal(mapping.descriptor.profile, tuple.profile);
    assert.equal(mapping.descriptor.model, tuple.model);
    assert.equal(mapping.descriptor.baseURL, tuple.baseURL);
    assert.equal(mapping.descriptor.nativePhysicalIdentity, journal.generation);
    accounts.push({
      provider,
      tuple,
      accountRef: account.accountRef,
      generation: journal.generation,
    });
  }
  const afterEnrollment = await stats();
  report({ phase: "enrollment-safe-counters", ...afterEnrollment });
  assert.equal(afterEnrollment.grok.exchanges, 1);
  assert.equal(afterEnrollment.grok.refreshes, 1);
  assert.equal(afterEnrollment.unexpected, 0);
  for (const selected of accounts) {
    const { provider, tuple, accountRef, generation } = selected;
    const account = await kernel.account(context, accountRef);
    const limitsInput = {
      ownerRef,
      accountRef,
      profileId: tuple.profile,
      expectedAuthorizationEpoch: account.epoch,
    };
    phase = provider + "-inert-reads";
    const before = await stats();
    await client.list();
    await client.get(accountRef);
    await client.getProviderConnectionCapabilities();
    const initial = await limitsClient.readAccountLimits(limitsInput);
    assert.ok(["unknown", "snapshot"].includes(initial.status));
    await assert.rejects(
      limitsClient.readAccountLimits({ ...limitsInput, ownerRef: "joined-provider-foreign" }),
      denied,
    );
    assert.deepEqual(await stats(), before);
    phase = provider + "-unsupported-settings-zero-entry";
    const negativeAccess = await consumer.runAccess({
      operationId: randomUUID(),
      invocationRef: randomUUID(),
      attemptRef: randomUUID(),
      accountRefs: [accountRef],
      subjectRef: "joined-provider-policy",
      policyRevision: 1,
      bindingRevision: 1,
      profileId: tuple.profile,
      limits,
      deadline: new Date(Date.now() + 30_000).toISOString(),
    });
    if (
      negativeAccess.operation.state !== "applied" ||
      negativeAccess.operation.result?.kind !== "execution"
    )
      throw new Error("missing negative execution");
    const negativeExecution = createExecutionClient({
      role: "execution",
      origin,
      token: negativeAccess.bearer,
    });
    const negativeRef = negativeAccess.operation.result.executionRef;
    for (const patch of [{ reasoning: { effort: "xhigh" } }, { service_tier: "priority" }])
      await assert.rejects(
        negativeExecution.request(negativeRef, {
          requestId: randomUUID(),
          admission: negativeAccess.admission,
          body: Buffer.from(
            JSON.stringify({
              model: tuple.model,
              stream: true,
              store: false,
              input: "Controlled negative",
              ...patch,
            }),
          ),
        }),
        (error: unknown) =>
          error instanceof GatewayError && error.diagnostic?.code === "invalid_request",
      );
    assert.deepEqual(await stats(), before, "unsupported settings never enter any provider");
    await negativeExecution.close(negativeRef, { operationId: randomUUID(), reason: "completed" });
    phase = provider + "-native-tool-roundtrip";
    const accept = Reflect.get(
      globalThis,
      Symbol.for("provider-joined-e2e.acceptProvider"),
    ) as unknown;
    if (accept !== undefined) {
      assert.equal(typeof accept, "function", "RR acceptance must be explicitly preloaded");
      try {
        await bounded(
          (
            accept as (input: {
              origin: string;
              token: string;
              accountRef: string;
              profileId: string;
              model: string;
              limits: typeof limits;
            }) => Promise<void>
          )({
            origin,
            token: consumerToken,
            accountRef,
            profileId: tuple.profile,
            model: tuple.model,
            limits,
          }),
          60_000,
        );
      } catch (error) {
        report({ phase: "actual-cli-native-counters", provider, counters: await stats() });
        const shapes = await controller("/tool-shapes");
        assert.equal(shapes.status, 200);
        report({ phase: "actual-cli-native-tool-shapes", provider, shapes: await shapes.json() });
        throw error;
      }
    } else {
      const access = await consumer.runAccess({
        operationId: randomUUID(),
        invocationRef: randomUUID(),
        attemptRef: randomUUID(),
        accountRefs: [accountRef],
        subjectRef: "joined-provider-policy",
        policyRevision: 1,
        bindingRevision: 1,
        profileId: tuple.profile,
        limits,
        deadline: new Date(Date.now() + 30_000).toISOString(),
      });
      if (access.operation.state !== "applied" || access.operation.result?.kind !== "execution")
        throw new Error("missing execution");
      const executionRef = access.operation.result.executionRef;
      const execution = createExecutionClient({ role: "execution", origin, token: access.bearer });
      const request = async (input: unknown, tools?: unknown[]): Promise<string> => {
        const result = await execution.request(executionRef, {
          requestId: randomUUID(),
          admission: access.admission,
          body: Buffer.from(
            JSON.stringify({
              model: tuple.model,
              stream: true,
              store: false,
              max_output_tokens: 100,
              ...(provider === "minimax" ? { service_tier: "default" } : {}),
              input,
              ...(tools ? { tools } : {}),
            }),
          ),
        });
        assert.equal(result.kind, "stream");
        if (result.kind !== "stream") throw new Error("missing stream");
        let output = "";
        for await (const part of result.body) output += new TextDecoder().decode(part);
        assert.match(output, /response.completed/);
        return output;
      };
      const first = await request("Controlled disposable fixture", [
        {
          type: "function",
          name: "joined_lookup",
          description: "Fixture lookup",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: true,
        },
      ]);
      assert.match(first, /function_call/);
      assert.match(first, /joined-call-1/);
      const completed = first.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).filter((data) => data !== "" && data !== "[DONE]")
        .map((data) => JSON.parse(data) as { type?: string; response?: { output?: Record<string, unknown>[] } })
        .find((event) => event.type === "response.completed");
      assert.ok(completed?.response?.output);
      const output = completed.response.output;
      const calls = output.filter((item) => item.type === "function_call");
      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call.name, "joined_lookup");
      assert.equal(call.arguments, "{}");
      assert.ok(call && typeof call.call_id === "string");
      if (provider === "minimax") {
        const reasoning = output.find((item) => item.type === "reasoning");
        assert.deepEqual(reasoning?.content, [{ type: "reasoning_text", text: "fixture thought" }]);
      }
      const second = await request([
        { role: "user", content: "Controlled disposable fixture" },
        ...output,
        { type: "function_call_output", call_id: call.call_id, output: "fixture-tool-result" },
      ]);
      assert.match(second, /findings/);
      assert.match(second, /revalidations/);
      await execution.close(executionRef, { operationId: randomUUID(), reason: "completed" });
    }
    const after = await stats();
    assert.equal(after[provider].dispatches - before[provider].dispatches, 2);
    assert.equal(after[provider].functionCalls - before[provider].functionCalls, 1);
    assert.equal(
      after[provider].functionOutputs - before[provider].functionOutputs,
      1,
      "native accepted the actual function continuation",
    );
    assert.equal(
      after[provider].customOutputs - before[provider].customOutputs,
      after[provider].customCalls - before[provider].customCalls,
      "every emitted custom call has a native-accepted output",
    );
    assert.equal(after.unexpected, 0);
    phase = provider + "-read-only-quota-collector";
    const collect = await controller("/quotas/collect", limitsInput);
    assert.equal(collect.status, 204);
    await collect.arrayBuffer();
    const quota = await limitsClient.readAccountLimits(limitsInput);
    assert.equal(quota.status, "snapshot");
    if (quota.status !== "snapshot") throw new Error("missing observed limits");
    assert.equal(quota.physicalGeneration, generation);
    assert.ok(quota.windows.length > 0);
    assert.equal(
      quota.windows.every((window) => window.provider === provider),
      true,
    );
    const collected = await stats();
    assert.equal(
      collected[provider].dispatches,
      after[provider].dispatches,
      "quota collection never infers",
    );
    assert.equal(
      collected[provider].quotaGets - after[provider].quotaGets,
      provider === "grok" ? 2 : 1,
      "collector uses exact source-owned read-only quota endpoints",
    );
    await limitsClient.readAccountLimits(limitsInput);
    await client.getProviderConnectionCapabilities();
    assert.deepEqual(await stats(), collected);
  }
  phase = "openrouter-dynamic-enrollment";
  const openRouterCreated = await client.connect({ operationId: randomUUID(), ownerRef, profileId: openRouterEnrollment.profile,
    displayName: "Dynamic OpenRouter", credential: { kind: "api_key", value: "fixture-provider-key-openrouter" } });
  assert.ok(openRouterCreated.state === "applied" && openRouterCreated.result?.kind === "account");
  const openRouterAccountRef = openRouterCreated.result.accountRef;
  const openRouterAccount = await client.get(openRouterAccountRef);
  const openRouterSelector = { ownerRef, accountRef: openRouterAccountRef, profileId: openRouterEnrollment.profile,
    expectedAuthorizationEpoch: openRouterAccount.authorizationEpoch };
  const openRouterSnapshot = await consumer.readAccountModels(openRouterSelector);
  assert.ok(openRouterSnapshot.status === "snapshot" && openRouterSnapshot.source === "openrouter");
  const selectedOpenRouterModel = openRouterSnapshot.models.find((model) => model.modelId === "unseen-vendor/new-model:free");
  assert.ok(selectedOpenRouterModel?.reasoning);
  assert.deepEqual(new Set(selectedOpenRouterModel.reasoning.allowed), new Set(["high", "medium"]));
  assert.equal(selectedOpenRouterModel.reasoning.default, "medium");
  await assert.rejects(consumer.readAccountModels({ ...openRouterSelector, ownerRef: "foreign" }), denied);
  const openRouterAccess = await consumer.runAccess({ operationId: randomUUID(), invocationRef: randomUUID(), attemptRef: randomUUID(),
    accountRefs: [openRouterAccountRef], subjectRef: "joined-provider-policy", policyRevision: 1, bindingRevision: 1,
    profileId: openRouterEnrollment.profile, limits, deadline: new Date(Date.now() + 30_000).toISOString() });
  assert.ok(openRouterAccess.operation.state === "applied" && openRouterAccess.operation.result?.kind === "execution");
  const openRouterExecutionRef = openRouterAccess.operation.result.executionRef;
  const openRouterExecution = createExecutionClient({ role: "execution", origin, token: openRouterAccess.bearer });
  const openRouterRequest = (model: string, patch: Record<string, unknown> = {}) => openRouterExecution.request(openRouterExecutionRef, {
    requestId: randomUUID(), admission: openRouterAccess.admission,
    body: Buffer.from(JSON.stringify({ model, stream: true, store: false, service_tier: "default", input: "Controlled dynamic OpenRouter", ...patch })) });
  const beforeOpenRouter = await stats();
  for (const [model, patch] of [["unknown/model", {}], ["unseen-vendor/new-model:free", { reasoning: { effort: "low" } }]] as const)
    await assert.rejects(openRouterRequest(model, patch), (error: unknown) => error instanceof GatewayError && error.diagnostic?.code === "invalid_request");
  assert.equal((await stats()).openrouter.dispatches, beforeOpenRouter.openrouter.dispatches);
  phase = "openrouter-dynamic-real-native-dispatch";
  const openRouterResponse = await openRouterRequest("unseen-vendor/new-model:free", { reasoning: { effort: "high" } });
  assert.equal(openRouterResponse.kind, "stream");
  if (openRouterResponse.kind !== "stream") throw new Error("missing OpenRouter stream");
  let openRouterText = "";
  for await (const part of openRouterResponse.body) openRouterText += new TextDecoder().decode(part);
  assert.match(openRouterText, /response.completed/);
  const openRouterAfter = await stats();
  assert.equal(openRouterAfter.openrouter.dispatches, beforeOpenRouter.openrouter.dispatches + 1);
  assert.ok(openRouterAfter.openrouterModelGets > 0);
  phase = "openrouter-dynamic-authoritative-removal";
  assert.equal((await controller("/openrouter/remove-model", {})).status, 204);
  const removedSnapshot = await consumer.readAccountModels({ ...openRouterSelector, forceRefresh: true });
  assert.ok(removedSnapshot.status === "snapshot" && removedSnapshot.source === "openrouter");
  assert.ok(!removedSnapshot.models.some((model) => model.modelId === "unseen-vendor/new-model:free"));
  await assert.rejects(openRouterRequest("unseen-vendor/new-model:free"), (error: unknown) => error instanceof GatewayError && error.diagnostic?.code === "invalid_request");
  assert.equal((await stats()).openrouter.dispatches, openRouterAfter.openrouter.dispatches);
  const openRouterPhysical = await store.mapping(context, openRouterSnapshot.physicalGeneration);
  assert.ok(openRouterPhysical);
  assert.equal(openRouterPhysical.descriptor.model, "birth/anchor");
  await openRouterExecution.close(openRouterExecutionRef, { operationId: randomUUID(), reason: "completed" });
  const latestOpenRouter = await client.get(openRouterAccountRef);
  assert.equal((await client.disable(openRouterAccountRef, { operationId: randomUUID(), expectedMetadataRevision: latestOpenRouter.metadataRevision })).state, "applied");
  phase = "grok-source-refresh";
  const beforeRefresh = await stats();
  assert.equal(await control.management.refreshOAuth(context), "observed");
  const afterRefresh = await stats();
  assert.deepEqual(
    afterRefresh,
    beforeRefresh,
    "fresh token from enrollment recovery does not repeat refresh",
  );
  await control.management.refreshOAuth(context);
  assert.deepEqual(await stats(), afterRefresh, "fresh replacement token does not repeat refresh");
  for (const selected of accounts) {
    const { provider, accountRef } = selected;
    phase = provider + "-reconnect-and-canonical-erasure";
    const current = await client.get(accountRef),
      operationId = randomUUID();
    let reconnected;
    if (provider === "grok") {
      const begun = await client.beginOAuthReconnect(accountRef, {
        operationId,
        expectedMetadataRevision: current.metadataRevision,
      });
      assert.ok(begun.authorizationURL);
      const response = await controller("/grok/authorize", {
        authorizeUrl: begun.authorizationURL,
      });
      assert.equal(response.status, 200);
      const callback = (await response.json()) as { state: string; code: string };
      reconnected = await client.completeOAuth({
        operationId,
        ownerRef,
        callbackURL: "http://127.0.0.1:56121/callback?" + new URLSearchParams(callback),
      });
    } else {
      reconnected = await client.reconnect(accountRef, {
        operationId,
        expectedMetadataRevision: current.metadataRevision,
        credential: { kind: "api_key", value: "fixture-provider-key-" + provider },
      });
    }
    assert.equal(reconnected.state, "applied");
    if (reconnected.state !== "applied" || reconnected.result?.kind !== "account")
      throw new Error("missing reconnect");
    assert.equal(reconnected.result.accountRef, accountRef);
    const journal = await store.readJournal(context, operationId);
    assert.ok(journal);
    assert.notEqual(journal.generation, selected.generation);
    const latest = await client.get(accountRef);
    assert.equal(latest.state, "active");
    assert.equal(
      (
        await client.disable(accountRef, {
          operationId: randomUUID(),
          expectedMetadataRevision: latest.metadataRevision,
        })
      ).state,
      "applied",
    );
  }
  phase = "canonical-generation-and-execution-cleanup";
  const claimCleanup = composeServiceCleanupClaim(kernel, context, worker);
  let idleCleanupTurns = 0;
  for (let count = 0; count < 64; count++) {
    const claim = await claimCleanup();
    // The production selector deliberately yields every second turn to refresh.
    if (!claim) {
      if (++idleCleanupTurns === 2) break;
      continue;
    }
    idleCleanupTurns = 0;
    if (claim.scope.kind === "generation")
      assert.equal(
        await control.management.cleanupClaim(context, claim),
        "erased",
        "every retained generation receives canonical native erasure ACK",
      );
    else {
      assert.ok(claim.scope.transports.length <= 2);
      for (const item of claim.scope.transports) {
        assert.ok(item.native && item.token);
        assert.equal(item.native.originRef, enrollment.originRef);
        assert.equal(item.native.engineIncarnation, enrollment.engineIncarnation);
        await cancelFacadeTransport(
          facadeOptions,
          context,
          { ...item, native: item.native, token: item.token },
          claim,
        );
      }
      await kernel.settleCleanup(context, claim.cleanupRef, worker, claim.token, true);
    }
    if (count === 63) throw new Error("cleanup did not drain");
  }
  const rrAcceptance =
    typeof Reflect.get(globalThis, Symbol.for("provider-joined-e2e.acceptProvider")) === "function";
  const rrReceipts: Record<string, unknown>[] = [];
  if (rrAcceptance) {
    const raw = Reflect.get(globalThis, Symbol.for("provider-joined-e2e.rrReceipts")) as unknown;
    assert.ok(Array.isArray(raw));
    assert.equal(raw.length, 4);
    for (const item of raw) {
      assert.ok(item && typeof item === "object");
      const observed = item as Record<string, unknown>;
      assert.ok(
        tuples.some(
          (tuple) => tuple.profile === observed.profileId && tuple.model === observed.model,
        ),
      );
      for (const name of ["actionArchiveSHA256", "codexBinarySHA256"])
        assert.match(String(observed[name]), /^[a-f0-9]{64}$/);
      assert.match(String(observed.actionRef), /^[a-f0-9]{40}$/);
      assert.match(String(observed.codexVersion), /^\d+\.\d+\.\d+$/);
      assert.equal(observed.providerEntries, 2);
      assert.equal(observed.streamCompletions, 2);
      for (const name of [
        "declaredFunctionTools",
        "declaredCustomTools",
        "returnedFunctionTools",
        "returnedCustomTools",
      ])
        assert.ok(Number.isSafeInteger(observed[name]) && (observed[name] as number) >= 0);
      assert.ok(
        (observed.declaredFunctionTools as number) > 0 &&
          (observed.returnedFunctionTools as number) > 0,
      );
      if ((observed.declaredCustomTools as number) > 0)
        assert.ok((observed.returnedCustomTools as number) > 0);
      assert.equal(observed.executionClosureAcknowledged, true);
      assert.equal(observed.reasoningOmitted, true);
      assert.equal(observed.fastOmitted, true);
      rrReceipts.push(
        Object.fromEntries(
          [
            "profileId",
            "model",
            "actionRef",
            "actionArchiveSHA256",
            "codexBinarySHA256",
            "codexVersion",
            "providerEntries",
            "streamCompletions",
            "declaredFunctionTools",
            "declaredCustomTools",
            "returnedFunctionTools",
            "returnedCustomTools",
            "reasoningOmitted",
            "fastOmitted",
            "executionClosureAcknowledged",
          ].map((name) => [name, observed[name]]),
        ),
      );
    }
    assert.equal(new Set(rrReceipts.map((item) => item.profileId)).size, 4);
  }
  phase = "native-close";
  child.stdin!.end("stop\n");
  stopped = true;
  const closed = await next("closed");
  assert.equal(closed.plaintextCredentials, 0);
  assert.equal(closed.retainedOAuthMaterial, 0);
  assert.equal(closed.retainedCredentials, 0);
  assert.equal(await bounded(childExit), 0);
  phase = "completed";
  const receipt = {
    phase,
    contract: "gateway-native-provider-joined/v1",
    nativeBinarySHA256: binarySHA256,
    nativeHead,
    gatewayBaseHead: gatewayHead,
    gatewaySourceArchiveSHA256,
    sourceHashes,
    nativeHTTP: true,
    gatewayFacadeAndSDK: true,
    rrAcceptance,
    rrReceipts,
    actualPostgreSQL: true,
    providerShapedFixture: true,
    liveProviderAccount: false,
    providers: accounts.map((account) => account.provider),
    controlledTextAndFunctionToolRoundTrip: true,
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
    nativeDiagnosticBytes,
  };
  await writeFile(join(scratch, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  report({ ...receipt, receiptPath: join(scratch, "receipt.json") });
}
try {
  await run();
} catch (error) {
  const frame =
    error instanceof Error
      ? /native-provider-joined\.ts:(\d+):(\d+)/.exec(error.stack ?? "")
      : undefined;
  report({
    phase: "failed",
    at: phase,
    code: error instanceof assert.AssertionError ? "assertion_failed" : "qualification_failed",
    ...(error instanceof Error ? { failureName: error.name } : {}),
    ...(error instanceof GatewayError
      ? { diagnosticCode: error.diagnostic?.code, httpStatus: error.httpStatus }
      : {}),
    ...(error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z_]+$/.test(error.code)
      ? { failureCode: error.code }
      : {}),
    ...(frame ? { frame: "native-provider-joined.ts:" + frame[1] + ":" + frame[2] } : {}),
  });
  process.exitCode = 1;
} finally {
  if (child && !stopped) child.stdin!.end("stop\n");
  if (childExit)
    await bounded(childExit, 5000).catch(() => {
      child?.kill("SIGTERM");
    });
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  await pool?.end();
}
