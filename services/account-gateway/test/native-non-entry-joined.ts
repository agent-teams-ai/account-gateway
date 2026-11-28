// Exact-source joined qualification only. The Go caller owns the real protected
// PostgreSQL deadlock and native HTTP service; this process owns a fresh Gateway
// database and its real authority, transport, facade and public SDK.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Server } from "node:http";
import { Pool } from "pg";
import { createExecutionClient, GatewayError } from "@agent-teams/account-gateway/http";
import { KernelError, defaults, identifier, uuid } from "../src/domain.ts";
import { PostgresKernel } from "../src/postgres.ts";
import { AccountManagement, physicalCandidate } from "../src/management.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { NativeManagementClient } from "../src/native-client.ts";
import { NativeAuthority } from "../src/native-authority.ts";
import { NativeHTTPTransport } from "../src/native-transport.ts";
import { createFacade, FacadeBearers } from "../src/facade.ts";
import { strictJSON } from "../src/facade-ingress.ts";

const credentials = {
  executionCredential: "joined-test-non-entry-execution",
  cleanupCredential: "joined-test-non-entry-cleanup",
  callbackCredential: "joined-test-non-entry-callback",
};
const limits = { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const consumerLogicalAuthorityHorizonMs = 190 * 60_000;
const consumerObservationWindowMs = 120_000;
const servers: Server[] = [];
let pool: Pool | undefined,
  phase = "guard";
let consumerDeadline: number | undefined;
const report = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
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
function loopback(value: unknown): string {
  assert.equal(typeof value, "string");
  const url = new URL(value as string);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash);
  assert.equal(url.pathname, "/");
  return url.origin;
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  const remaining = consumerDeadline === undefined ? 15_000 : consumerDeadline - Date.now();
  assert.ok(remaining > 0, "original joined deadline elapsed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((resolve, reject) => {
        timer = setTimeout(
          () => {
            reject(new KernelError("unavailable"));
          },
          Math.min(15_000, remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function continueAfterReady(
  expected: "continue" | "continue-conflict" = "continue",
): Promise<void> {
  const input = createInterface({ input: process.stdin });
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        input.once("line", (line) => {
          try {
            assert.ok(line.length <= 128);
            assert.deepEqual(strictJSON(Buffer.from(line)), { phase: expected });
            resolve();
          } catch {
            reject(new KernelError("invalid"));
          }
        });
        input.once("close", () => {
          reject(new KernelError("unavailable"));
        });
      }),
    );
  } finally {
    input.close();
  }
}

async function run(): Promise<void> {
  assert.equal(process.env.AG_NATIVE_NON_ENTRY_JOINED_ALLOW, "disposable_pg17_10");
  const file = process.env.AG_NATIVE_NON_ENTRY_JOINED_FIXTURE;
  const dsn = process.env.AG_NATIVE_NON_ENTRY_JOINED_DSN;
  assert.ok(typeof file === "string" && isAbsolute(file));
  assert.ok(typeof dsn === "string" && dsn.length > 0);
  const url = new URL(dsn);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.password && !url.search && !url.hash);
  assert.match(url.pathname, /^\/ag_kernel_test_non_entry_[a-z0-9_]+$/);
  const bytes = await readFile(file);
  assert.ok(bytes.length <= 16_384);
  const fixture = strictJSON(bytes, true) as {
    consumerId: string;
    accountRef: string;
    ownerRef: string;
    operationId: string;
    qualificationRef: string;
    descriptor: Parameters<typeof physicalCandidate>[0];
    nativeOrigin: string;
    nativePublicOrigin: string;
    mode: unknown;
    scenario?: unknown;
    deadline?: unknown;
    observationDeadline?: unknown;
  };
  for (const value of [
    fixture.consumerId,
    fixture.ownerRef,
    fixture.operationId,
    fixture.qualificationRef,
  ]) {
    identifier(value);
  }
  uuid(fixture.accountRef);
  const descriptor = physicalCandidate(fixture.descriptor);
  assert.equal(descriptor.nativePhysicalIdentity, descriptor.generation);
  assert.equal(descriptor.profile, "openai-responses-apikey-v1");
  assert.ok(fixture.mode === "private" || fixture.mode === "public");
  assert.ok(fixture.scenario === undefined || fixture.scenario === "request-retry-consumer");
  const consumer = fixture.scenario === "request-retry-consumer";
  if (consumer) {
    assert.equal(typeof fixture.deadline, "string");
    const deadline = new Date(fixture.deadline as string);
    assert.equal(deadline.toISOString(), fixture.deadline);
    assert.equal(typeof fixture.observationDeadline, "string");
    const observationDeadline = new Date(fixture.observationDeadline as string);
    assert.equal(observationDeadline.toISOString(), fixture.observationDeadline);
    consumerDeadline = observationDeadline.getTime();
    assert.ok(consumerDeadline > Date.now() && consumerDeadline - Date.now() <= consumerObservationWindowMs);
    assert.ok(deadline.getTime() > Date.now() && deadline.getTime() - Date.now() <= consumerLogicalAuthorityHorizonMs);
    assert.equal(deadline.getTime() - consumerDeadline, consumerLogicalAuthorityHorizonMs - consumerObservationWindowMs);
  } else {
    assert.equal(fixture.deadline, undefined);
    assert.equal(fixture.observationDeadline, undefined);
  }
  const nativeOrigin = loopback(fixture.nativeOrigin);
  const nativePublicOrigin = loopback(fixture.nativePublicOrigin);
  const provider = new URL(descriptor.baseURL);
  assert.equal(provider.protocol, "https:");
  assert.equal(provider.hostname, "127.0.0.1");
  phase = "database";
  pool = new Pool({ connectionString: dsn, max: 6, connectionTimeoutMillis: 5000 });
  pool.on("error", () => {});
  const version = (
    await pool.query<{ version: string; db: string }>(
      "SELECT current_setting('server_version') AS version,current_database() AS db",
    )
  ).rows[0];
  assert.match(version.version, /^17\.10(?:$| )/);
  assert.equal(version.db, url.pathname.slice(1));
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')"))
      .rowCount,
    0,
  );
  for (const migration of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .toSorted()) {
    await pool.query(
      await readFile(new URL("../migrations/" + migration, import.meta.url), "utf8"),
    );
  }
  const context = { consumerId: fixture.consumerId },
    worker = randomUUID();
  const kernel = new PostgresKernel(
    pool,
    consumer ? { ...defaults, maxRunMs: consumerLogicalAuthorityHorizonMs } : defaults,
  );
  const store = new PostgresManagementStore(
    pool,
    new IntentSecrets(randomBytes(32), randomBytes(32)),
  );
  await kernel.issuer(context);
  await kernel.heartbeat(context, worker);
  phase = "original-native-identity";
  // Same test-only original-identity adoption used by the retained-custody
  // joined fixture. No production enrollment/management route is changed.
  await pool.query(
    "INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state) VALUES ($1,$2,$3,$4,'Joined non-entry','staging')",
    [fixture.consumerId, fixture.accountRef, fixture.ownerRef, descriptor.profile],
  );
  await pool.query(
    "INSERT INTO ag_kernel.operations(consumer,id,intent,state,account_ref) VALUES ($1,$2,$3::jsonb,'pending',$4)",
    [
      fixture.consumerId,
      fixture.operationId,
      JSON.stringify({
        kind: "create",
        digest: randomUUID(),
        target: null,
        expectedRevision: null,
        owner: fixture.ownerRef,
        profile: descriptor.profile,
        name: "Joined non-entry",
      }),
      fixture.accountRef,
    ],
  );
  await pool.query(
    "INSERT INTO ag_kernel.candidates(consumer,generation,account_ref,operation_id,profile,expected_revision,expected_epoch,state,worker) VALUES ($1,$2,$3,$4,$5,1,1,'creating',$6)",
    [
      fixture.consumerId,
      descriptor.generation,
      fixture.accountRef,
      fixture.operationId,
      descriptor.profile,
      worker,
    ],
  );
  const profile = {
    profile: descriptor.profile,
    baseURL: descriptor.baseURL,
    model: descriptor.model,
    qualificationRef: fixture.qualificationRef,
  };
  const journal = await store.journal(
    {
      ...context,
      operationId: fixture.operationId,
      accountRef: fixture.accountRef,
      ownerRef: fixture.ownerRef,
      purpose: "create",
    },
    descriptor.generation,
    worker,
    profile,
  );
  await store.saveMapping({ ...journal, descriptor });
  assert.equal(
    (await kernel.acknowledgeCandidate(context, fixture.operationId, worker, descriptor)).state,
    "applied",
  );
  let saved: Awaited<ReturnType<typeof kernel.savedExecution>> | undefined;
  if (!consumer) {
    const prepared = await kernel.prepare(context, {
      operationId: randomUUID(),
      intentDigest: "joined-non-entry-approval",
      invocationRef: randomUUID(),
      attemptRef: randomUUID(),
      permittedAccounts: [fixture.accountRef],
      profile: descriptor.profile,
      policySubject: "joined-non-entry-policy",
      policyRevision: 1,
      bindingRevision: 1,
      issuerEpoch: await kernel.issuer(context),
      deadline: new Date(Date.now() + 60_000),
      limits,
    });
    assert.ok(typeof prepared.executionRef === "string" && prepared.executionRef.length > 0);
    saved = await kernel.savedExecution(context, prepared.executionRef);
  }
  const bearer = "joined-test-non-entry-public-execution";
  const controlBearer = "joined-test-non-entry-run-control";
  const bearers = new FacadeBearers(
    saved
      ? [{ role: "execution", consumerId: context.consumerId, token: bearer, saved }]
      : [
          {
            role: "run-control",
            consumerId: context.consumerId,
            token: controlBearer,
            ownerRefs: [fixture.ownerRef],
            profileIds: [descriptor.profile],
            limits: { ...limits, requests: 3 },
            maxRunMs: consumerLogicalAuthorityHorizonMs,
          },
        ],
  );
  const issued: Array<{ executionRef: string; token: string }> = [];
  if (consumer) {
    // Observe actual deterministic issuance; never substitute a test execution grant.
    const issue = bearers.upsertExecution.bind(bearers);
    bearers.upsertExecution = (...args: Parameters<typeof issue>) => {
      const token = issue(...args);
      issued.push({ executionRef: args[1].admission.executionRef, token });
      return token;
    };
  }
  const engineIncarnation = randomUUID();
  const authority = new NativeAuthority({
    kernel,
    store,
    executionBearers: bearers,
    config: {
      origin: nativeOrigin,
      enrollment: {
        originRef: "non-entry-joined-origin",
        engineIncarnation,
        worker,
        qualificationRef: fixture.qualificationRef,
      },
      consumers: [{ consumerId: context.consumerId, ...credentials }],
      profiles: [
        {
          ...profile,
          requestBytes: 4096,
          outputBytes: 4096,
          tokens: 100,
          providerTokenUpperBound: 200,
        },
      ],
      timeoutMs: 10_000,
      closureWaitMs: 1000,
    },
  });
  const callbackOrigin = await listen(authority.createServer());
  const management = new AccountManagement({
    kernel,
    store,
    worker,
    custody: new IntentSecrets(randomBytes(32), randomBytes(32)),
    profiles: [profile],
    native: new NativeManagementClient({
      origin: nativeOrigin,
      consumerId: context.consumerId,
      controlCredential: "joined-test-unused-management",
    }),
    proof: {
      async verify() {
        return true;
      },
    },
  });
  const facade = createFacade({
    kernel,
    store,
    management,
    bearers,
    transport: new NativeHTTPTransport(authority),
    enrollment: authority.configuration.enrollment,
    intentHmacKey: randomBytes(32),
    timeoutMs: 15_000,
    profiles: [
      {
        dto: {
          profileId: descriptor.profile,
          protocol: "openai-responses",
          modelIds: [descriptor.model],
          authKinds: ["api_key"],
        },
        maxOutputTokens: 200,
      },
    ],
  });
  const retryProofRequests: Array<{ path: string; authorization: string | undefined }> = [];
  if (consumer) {
    facade.on("request", (request) => {
      if (request.method === "GET" && (request.url ?? "").endsWith("/retry-proof")) {
        retryProofRequests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
      }
    });
  }
  const origin = await listen(facade);
  report({ phase: "ready", callbackOrigin, engineIncarnation });
  await continueAfterReady();
  if (consumer) {
    const broker = loopback(process.env.RR_NATIVE_NON_ENTRY_CONSUMER_ORIGIN);
    const brokerToken = process.env.RR_NATIVE_NON_ENTRY_CONSUMER_TOKEN;
    assert.ok(typeof brokerToken === "string" && /^[a-f0-9]{64}$/.test(brokerToken));
    const call = async (
      step: "prepare" | "prior" | "current" | "held" | "verify",
      value: object = {},
    ): Promise<Record<string, unknown>> => {
      assert.ok(consumerDeadline !== undefined && consumerDeadline > Date.now());
      const response = await fetch(broker + "/" + step, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(15_000, consumerDeadline - Date.now())),
        headers: {
          authorization: "Bearer " + brokerToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      });
      assert.equal(response.status, 200);
      assert.ok(response.body !== null);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const chunkBytes: unknown = chunk.value;
        assert.ok(chunkBytes instanceof Uint8Array);
        size += chunkBytes.byteLength;
        assert.ok(size <= 16_384);
        chunks.push(chunkBytes);
      }
      return strictJSON(Buffer.concat(chunks), true) as Record<string, unknown>;
    };
    phase = "consumer-prepare";
    assert.deepEqual(
      await call("prepare", {
        gatewayOrigin: origin,
        nativePublicOrigin,
        mode: fixture.mode,
        runControlBearer: controlBearer,
        accountRef: fixture.accountRef,
        profileId: descriptor.profile,
        model: descriptor.model,
        deadline: fixture.deadline,
        observationDeadline: fixture.observationDeadline,
      }),
      { phase: "prepared" },
    );
    assert.deepEqual(await call("prior"), { phase: "prior-paid-completed" });
    assert.equal(issued.length, 1, "one original run access is issued");
    const original = issued.at(0);
    assert.ok(original !== undefined);
    const client = createExecutionClient({
      role: "execution",
      origin,
      token: original.token,
      timeoutMs: 15_000,
    });
    const priorRows = (
      await pool.query<{ id: string; transport_occupied: boolean }>(
        "SELECT id,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2",
        [context.consumerId, original.executionRef],
      )
    ).rows;
    assert.equal(priorRows.length, 1);
    const prior = priorRows.at(0);
    assert.ok(prior !== undefined && !prior.transport_occupied);
    assert.equal(
      (await kernel.request(context, original.executionRef, prior.id)).effect,
      "completed",
    );
    const acknowledgement = kernel.acknowledgeTransportClosed.bind(kernel);
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let heldRequestRef: string | undefined;
    kernel.acknowledgeTransportClosed = async (...args: Parameters<typeof acknowledgement>) => {
      const proof = args[2];
      if (
        args[0].consumerId !== context.consumerId ||
        proof.executionRef !== original.executionRef ||
        proof.requestRef === prior.id
      ) {
        return acknowledgement(...args);
      }
      assert.equal(
        (await kernel.request(context, original.executionRef, proof.requestRef)).effect,
        "rejected_before_dispatch",
      );
      heldRequestRef ??= proof.requestRef;
      assert.equal(proof.requestRef, heldRequestRef);
      reached.resolve();
      await bounded(release.promise);
      return acknowledgement(...args);
    };
    let pending: Promise<Record<string, unknown>> | undefined;
    let currentFinished = false;
    try {
      report({ phase: "prior-paid-completed" });
      await continueAfterReady("continue-conflict");
      phase = "consumer-held-ack";
      pending = call("current");
      void pending.then(
        () => {
          currentFinished = true;
          return null;
        },
        () => {
          currentFinished = true;
          return null;
        },
      );
      await bounded(reached.promise);
      assert.equal(
        currentFinished,
        false,
        "current Action request is still pending at the actual ACK",
      );
      const held = (
        await pool.query<{ id: string; transport_occupied: boolean }>(
          "SELECT id,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2",
          [context.consumerId, original.executionRef],
        )
      ).rows;
      assert.equal(held.length, 2);
      const roots = held.filter((row) => row.transport_occupied);
      assert.equal(roots.length, 1);
      const root = roots.at(0);
      assert.ok(root !== undefined);
      assert.equal(root.id, heldRequestRef);
      assert.equal(
        (await kernel.request(context, original.executionRef, root.id)).effect,
        "rejected_before_dispatch",
      );
      assert.equal(retryProofRequests.length, 0);
      await assert.rejects(
        client.retryProof(original.executionRef, root.id),
        (error: unknown) => error instanceof GatewayError && error.code === "safe_error",
      );
      assert.equal(retryProofRequests.length, 1);
      assert.deepEqual(await call("held"), { phase: "held-without-retry" });
      assert.equal(currentFinished, false);
      // Only the failed root uses this hold. The successor's successful close
      // takes the unchanged real acknowledgement path.
      kernel.acknowledgeTransportClosed = acknowledgement;
      release.resolve();
      assert.deepEqual(await bounded(pending), { phase: "current-paid-completed" });
      phase = "consumer-proof-after-ack";
      assert.equal(retryProofRequests.length, 2, "the real RR relay reads proof exactly once");
      assert.deepEqual(await client.retryProof(original.executionRef, root.id), {
        kind: "request-retry-proof/v1",
        consumerId: context.consumerId,
        executionRef: original.executionRef,
        requestRef: root.id,
        nonEntryReason: "admission_storage_conflict",
        transportClosed: true,
      });
      assert.equal(retryProofRequests.length, 3);
      assert.ok(
        retryProofRequests.every(
          (request) =>
            request.path ===
              "/v1/executions/" +
                encodeURIComponent(original.executionRef) +
                "/requests/" +
                encodeURIComponent(root.id) +
                "/retry-proof" && request.authorization === "Bearer " + original.token,
        ),
      );
      const final = (
        await pool.query<{ id: string; transport_occupied: boolean }>(
          "SELECT id,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2",
          [context.consumerId, original.executionRef],
        )
      ).rows;
      assert.equal(final.length, 3);
      assert.equal(new Set(final.map((row) => row.id)).size, 3);
      assert.equal(final.filter((row) => row.transport_occupied).length, 0);
      const effects = await Promise.all(
        final.map(
          async (row) => (await kernel.request(context, original.executionRef, row.id)).effect,
        ),
      );
      assert.deepEqual(effects.toSorted(), ["completed", "completed", "rejected_before_dispatch"]);
      assert.equal(
        (
          await pool.query<{ request_count: number }>(
            "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [context.consumerId, original.executionRef],
          )
        ).rows[0]?.request_count,
        3,
      );
      assert.equal(issued.length, 1, "retry must not acquire or renew run access");
      assert.deepEqual(await call("verify"), { phase: "verified" });
      phase = "completed";
      report({
        phase,
        contract: "native-non-entry-consumer/v1",
        mode: fixture.mode,
        proofAfterAck: true,
        priorPaidPreserved: true,
        originalSpent: true,
        oneSuccessor: true,
      });
    } finally {
      kernel.acknowledgeTransportClosed = acknowledgement;
      release.resolve();
      await pending?.catch(() => {});
    }
    return;
  }
  assert.ok(saved !== undefined);
  phase = "request-before-ack";
  const client = createExecutionClient({
    role: "execution",
    origin,
    token: bearer,
    timeoutMs: 15_000,
    ...(fixture.mode === "public" ? { inferenceOrigin: nativePublicOrigin } : {}),
  });
  const acknowledgement = kernel.acknowledgeTransportClosed.bind(kernel);
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  kernel.acknowledgeTransportClosed = async (...args: Parameters<typeof acknowledgement>) => {
    reached.resolve();
    await release.promise;
    return acknowledgement(...args);
  };
  const { executionRef: ref, issuerEpoch: _issuer, ...admission } = saved.admission;
  const requestId = "original-non-entry";
  const request = {
    requestId,
    admission,
    body: Buffer.from(
      JSON.stringify({
        model: descriptor.model,
        stream: true,
        store: false,
        service_tier: "default",
        input: "fixture",
      }),
    ),
  };
  const pending = client.request(ref, request);
  void pending.catch(() => {});
  try {
    await bounded(reached.promise);
    assert.equal(
      (await kernel.request(context, ref, requestId)).effect,
      "rejected_before_dispatch",
    );
    await assert.rejects(
      client.retryProof(ref, requestId),
      (error: unknown) => error instanceof GatewayError && error.code === "safe_error",
    );
    assert.equal(
      (
        await pool.query<{ transport_occupied: boolean }>(
          "SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3",
          [context.consumerId, ref, requestId],
        )
      ).rows[0].transport_occupied,
      true,
    );
    release.resolve();
    const response = await bounded(pending);
    assert.equal(response.kind, "status");
    const status = await client.status(ref, requestId);
    assert.equal(status.effect, "rejected_before_dispatch");
    assert.deepEqual(status.error?.retry, { kind: "never" });
    phase = "proof-after-ack";
    const expected = {
      kind: "request-retry-proof/v1",
      consumerId: context.consumerId,
      executionRef: ref,
      requestRef: requestId,
      nonEntryReason: "admission_storage_conflict",
      transportClosed: true,
    };
    assert.deepEqual(await client.retryProof(ref, requestId), expected);
    assert.deepEqual(
      await new PostgresKernel(pool).requestRetryProof(context, ref, requestId),
      expected,
    );
    assert.equal(Object.hasOwn(status, "nonEntryReason"), false);
    assert.equal((await client.request(ref, request)).kind, "status");
    assert.equal(
      (
        await pool.query<{ request_count: number }>(
          "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
          [context.consumerId, ref],
        )
      ).rows[0].request_count,
      1,
    );
    phase = "negative-authority";
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(
      client.request(
        ref,
        { ...request, requestId: "cancelled-new-request" },
        { signal: canceled.signal },
      ),
      (error: unknown) => error instanceof GatewayError && error.code === "cancelled",
    );
    await assert.rejects(
      client.retryProof(randomUUID(), requestId),
      (error: unknown) => error instanceof GatewayError && error.code === "safe_error",
    );
    await assert.rejects(
      client.retryProof(ref, "missing-request"),
      (error: unknown) => error instanceof GatewayError && error.code === "safe_error",
    );
    await pool.query(
      "UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
      [context.consumerId, worker],
    );
    await pool.query(
      "UPDATE ag_kernel.executions SET deadline=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",
      [context.consumerId, ref],
    );
    await assert.rejects(
      client.retryProof(ref, requestId),
      (error: unknown) => error instanceof GatewayError && error.code === "safe_error",
    );
    assert.equal(
      (await kernel.request(context, ref, requestId)).effect,
      "rejected_before_dispatch",
    );
    const row = (
      await pool.query<{ requests: number; occupied: number }>(
        "SELECT count(*)::integer AS requests,count(*) FILTER (WHERE transport_occupied)::integer AS occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2",
        [context.consumerId, ref],
      )
    ).rows[0];
    assert.deepEqual(row, { requests: 1, occupied: 0 });
    phase = "completed";
    report({
      phase,
      contract: "native-non-entry-joined/v1",
      mode: fixture.mode,
      proofAfterAck: true,
      originalSpent: true,
      expiredDenied: true,
    });
  } finally {
    release.resolve();
    await pending.catch(() => {});
  }
}

try {
  await run();
} catch (error) {
  report({
    phase: "failed",
    boundary: phase,
    category: error instanceof assert.AssertionError ? "assertion" : "unavailable",
  });
  process.exitCode = 1;
} finally {
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
