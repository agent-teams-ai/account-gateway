// Synthetic Go peer over real TCP + real disposable SQL. This suite does not
// qualify actual Go, provider protocol conversion, launcher, or RR assembly.
import test, { before as beforeTests, after as afterTests } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { PostgresKernel } from "../src/postgres.ts";
import { AccountManagement } from "../src/management.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import {
  NativeManagementClient,
  NativeOAuthEnrollmentClient,
  NativeFailure,
} from "../src/native-client.ts";
import type { OAuthScope } from "../src/management.ts";
import { createFacade, FacadeBearers } from "../src/facade.ts";
import type { NativeTransport } from "../src/facade.ts";
import { NativeAuthority } from "../src/native-authority.ts";
import { NativeHTTPTransport } from "../src/native-transport.ts";
import {
  NativeControlAdmission,
  admitNativeCallback,
  inServiceLane,
  sharedCheckout,
} from "../src/service-admission.ts";
import { KernelError } from "../src/domain.ts";
import type { NativeDispatchProof, PrivateAdmission } from "../src/domain.ts";
import type { Descriptor, Receipt } from "../src/native-wire.ts";

let pool: Pool;
// Each synthetic creation has its own native identity, as the native DB sequence does.
let nextNativeAccountId = 1;
function postgresSetupFailure(error: unknown): Error {
  return error instanceof assert.AssertionError
    ? error
    : new Error("NOT_RUN: disposable PostgreSQL setup unavailable");
}
function refreshFixtureFailure(error: unknown): Error {
  return error instanceof assert.AssertionError
    ? error
    : new Error("synthetic refresh fixture failed");
}
function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
beforeTests(async () => {
  const dsn = process.env.AG_NATIVE_BRIDGE_TEST_DSN,
    database = process.env.AG_NATIVE_BRIDGE_DISPOSABLE_DB;
  if (
    dsn === undefined ||
    dsn === "" ||
    database === undefined ||
    database === "" ||
    !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
    process.env.AG_KERNEL_TEST_ALLOW !== "disposable_pg17_10"
  ) {
    throw new Error("NOT_RUN: NEW disposable PG17.10 native bridge database required");
  }
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    throw new Error("NOT_RUN: invalid disposable designation");
  }
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/" + database ||
    u.search ||
    u.hash
  ) {
    throw new Error("NOT_RUN: refusing remote or unspecified database");
  }
  pool = new Pool({ connectionString: dsn, max: 8, connectionTimeoutMillis: 5000 });
  pool.on("error", () => {});
  try {
    const r = (
      await pool.query<{ db: string; version: string }>(
        "SELECT current_database() AS db,current_setting('server_version') AS version",
      )
    ).rows[0];
    assert.equal(r.db, database);
    assert.match(r.version, /^17\.10(?:$| )/);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')",
        )
      ).rowCount,
      0,
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .toSorted()) {
      await pool.query(await readFile(new URL(file, directory), "utf8"));
    }
  } catch (error) {
    throw postgresSetupFailure(error);
  }
});
afterTests(async () => {
  const ownedPool: unknown = pool;
  if (ownedPool instanceof Pool) {
    await ownedPool.end();
  }
});

const profile = {
  profile: "synthetic-profile",
  baseURL: "https://fixture.invalid/v1",
  model: "fixture-model",
  qualificationRef: "synthetic-only",
};
const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const payload = Buffer.from(
  '{"model":"fixture-model","stream":true,"store":false,"service_tier":"default","input":[{"n":9007199254740993,"v":1.2300,"s":"\\u0061"}]}',
);
const credentials = {
  executionCredential: "test-fixture-literal-execution",
  cleanupCredential: "test-fixture-literal-cleanup",
  callbackCredential: "test-fixture-literal-callback",
};
async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    s.listen(0, "127.0.0.1", resolve);
  });
  const a = s.address();
  assert.ok(a !== null && typeof a === "object");
  return "http://127.0.0.1:" + a.port;
}
async function stop(s: Server): Promise<void> {
  s.closeAllConnections();
  await new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });
}

// Decoder/transport risk only: the journal/current owner authority is exercised
// once at the real F PostgreSQL boundary in oauth-enrollment-postgres.test.ts.
// RED if this maintenance method accepts token/version DTOs, an identity alias,
// a redirect replay, or the enrollment client's configurable 30s refresh deadline.
void test(
  "private refresh HTTP: original four fields, finite safe ACK and one capped attempt",
  { timeout: 15_000 },
  async () => {
    const scope: OAuthScope = {
      consumerId: "refresh-transport-fixture",
      operationId: "original-connect-operation",
      accountRef: randomUUID(),
      generation: randomUUID(),
      ownerRef: "refresh-owner",
    };
    const control = "synthetic-refresh-control",
      sent: unknown[] = [];
    let status = 200,
      reply: Buffer | undefined;
    let requestObserved = Promise.withResolvers<void>(),
      fixtureError: unknown;
    const peer = createServer((req, res) => {
      void (async () => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/private/native/v1/oauth/refresh");
        assert.equal(req.headers.authorization, "Bearer " + control);
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        sent.push(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
        requestObserved.resolve();
        if (reply === undefined) {
          return;
        } // Hold only this local fixture socket.
        res.writeHead(status, {
          "content-type": "application/json",
          ...(status === 307 ? { location: "/other-route" } : {}),
        });
        res.end(reply);
      })().catch((error: unknown) => {
        fixtureError = error;
        res.destroy();
      });
    });
    const origin = await listen(peer);
    const client = new NativeOAuthEnrollmentClient({
      origin,
      consumerId: scope.consumerId,
      ownerRef: scope.ownerRef,
      controlCredential: control,
      deadlineMs: 30_000,
    });
    const expected = {
      operation: scope.operationId,
      account_ref: scope.accountRef,
      owner_ref: scope.ownerRef,
      generation: scope.generation,
    };
    const ack = (state: string, extra: object = {}) => ({
      operation: scope.operationId,
      account_ref: scope.accountRef,
      state,
      ...extra,
    });
    try {
      for (const state of ["idle", "prepared", "entered", "completed", "unknown"] as const) {
        reply = Buffer.from(JSON.stringify(ack(state, { refresh_ref: "opaque-refresh-attempt" })));
        const before = sent.length;
        assert.deepEqual(await client.refresh(scope), {
          operationId: scope.operationId,
          accountRef: scope.accountRef,
          state,
          refreshRef: "opaque-refresh-attempt",
        });
        assert.deepEqual(sent.slice(before), [expected]);
      }
      const invalid = [
        ack("expired"),
        ack("completed", { credentialVersion: 2 }),
        ack("completed", { tokens: {} }),
        ack("completed", { operation: "foreign-operation" }),
        ack("completed", { account_ref: randomUUID() }),
        ack("completed", { refresh_ref: "" }),
        ack("completed", { refresh_ref: "x".repeat(129) }),
      ];
      const duplicate =
        '{"operation":"' +
        scope.operationId +
        '","account_ref":"' +
        scope.accountRef +
        '","state":"idle","st\\u0061te":"completed"}';
      for (const bytes of [
        ...invalid.map((value) => Buffer.from(JSON.stringify(value))),
        Buffer.from(duplicate),
        Buffer.from([0xff]),
      ]) {
        reply = bytes;
        const before = sent.length;
        await assert.rejects(
          client.refresh(scope),
          (e: unknown) => e instanceof NativeFailure && e.code === "invalid_readback",
        );
        assert.deepEqual(
          sent.slice(before),
          [expected],
          "bad readback cannot retry or export native body",
        );
      }
      status = 307;
      reply = Buffer.from("{}");
      let before = sent.length;
      await assert.rejects(
        client.refresh(scope),
        (e: unknown) => e instanceof NativeFailure && e.code === "redirect",
      );
      assert.deepEqual(sent.slice(before), [expected], "no redirect followup");
      status = 200;
      reply = undefined;
      before = sent.length;
      requestObserved = Promise.withResolvers<void>();
      const pending = client.refresh(scope);
      void pending.catch(() => {});
      await requestObserved.promise;
      // Input replacement after dispatch cannot alter the original identity tuple.
      const originalOperation = scope.operationId;
      Object.assign(scope, { operationId: "later-operation" });
      await assert.rejects(
        Promise.race([
          pending,
          new Promise<never>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("refresh exceeded 5s deadline allowance"));
            }, 6000);
            timer.unref();
          }),
        ]),
        (e: unknown) => e instanceof NativeFailure && e.code === "deadline",
      );
      assert.equal(originalOperation, expected.operation);
      assert.deepEqual(sent.slice(before), [expected]);
      const hasFixtureError = Boolean(fixtureError);
      if (hasFixtureError) {
        throw refreshFixtureFailure(fixtureError);
      }
    } finally {
      await stop(peer);
    }
  },
);
type Mode =
  | "complete"
  | "unclosed"
  | "closeFailed"
  | "partial"
  | "overflow"
  | "noentry"
  | "lost-admit-ack"
  | "redirect"
  | "held"
  | "early-ack"
  | "large";
interface NativeInput {
  requestRef: string;
  worker: string;
  admission: PrivateAdmission;
  descriptor: Descriptor;
}
function latch() {
  let resolveLatch!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveLatch = resolve;
  });
  return { promise, resolve: resolveLatch };
}
function admissionBarrier(requestId: string) {
  return { requestId, reached: latch(), release: latch(), acked: latch(), latched: false };
}
async function waitFor(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("fixture barrier timeout"));
        }, 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const ignoreEntry = (): void => {};

async function fixture(
  mode: Mode = "complete",
  options: { maxPending?: number; timeoutMs?: number } = {},
) {
  const executionLimits = mode === "large" ? { ...limits, outputBytes: 1_048_576 } : limits;
  const streamFrames =
    mode === "large"
      ? Array.from({ length: 256 }, () =>
          Buffer.from(
            "data: " +
              JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(2197) }) +
              "\n\n",
          ),
        )
      : [];
  const expectedStream = Buffer.concat([Buffer.from("data: fixture\n\n"), ...streamFrames]);
  const transportChunkSizes: number[] = [];
  const context = { consumerId: "native-" + randomUUID() },
    worker = randomUUID(),
    incarnation = randomUUID();
  const kernel = new PostgresKernel(pool),
    store = new PostgresManagementStore(pool, new IntentSecrets(randomBytes(32), randomBytes(32)));
  await kernel.heartbeat(context, worker);
  const operationId = randomUUID();
  const account = await kernel.beginAccount(context, {
    operationId,
    kind: "create",
    intentDigest: "synthetic-account",
    ownerRef: "workspace-fixture",
    profile: profile.profile,
    displayName: "Fixture",
  });
  assert.ok(isNonemptyString(account.accountRef));
  const candidate = await kernel.startCandidate(context, operationId, worker);
  assert.ok(candidate);
  const scope = {
    consumerId: context.consumerId,
    operationId,
    accountRef: account.accountRef,
    ownerRef: "workspace-fixture",
    purpose: "create" as const,
  };
  const journal = await store.journal(scope, candidate.candidate, worker, profile);
  const physical = {
    generation: candidate.candidate,
    nativePhysicalIdentity: candidate.candidate,
    nativeId: nextNativeAccountId++,
    createdAt: "2026-10-03T04:05:06.123456789Z",
    profile: profile.profile,
    baseURL: profile.baseURL,
    model: profile.model,
  };
  await store.saveMapping({ ...journal, descriptor: physical });
  await kernel.acknowledgeCandidate(context, operationId, worker, physical);
  const prepared = await kernel.prepare(context, {
    operationId: randomUUID(),
    intentDigest: "synthetic-approval",
    invocationRef: "invocation-" + randomUUID(),
    attemptRef: "opaque-attempt",
    permittedAccounts: [account.accountRef],
    profile: profile.profile,
    policySubject: "binding-fixture",
    policyRevision: 2,
    bindingRevision: 3,
    issuerEpoch: await kernel.issuer(context),
    deadline: new Date(Date.now() + 45_000),
    limits: executionLimits,
  });
  assert.ok(isNonemptyString(prepared.executionRef));
  const saved = await kernel.savedExecution(context, prepared.executionRef);
  let barrier: ReturnType<typeof admissionBarrier> | undefined;
  const currentWorkerLease = kernel.currentWorkerLease.bind(kernel);
  kernel.currentWorkerLease = async (...args: Parameters<typeof currentWorkerLease>) => {
    const lease = await currentWorkerLease(...args),
      b = barrier;
    // Pause the REAL facade callback at its lease read AFTER the SQL claim,
    // before NativeAuthority can receive/attach the returned closure proof.
    if (b && !b.latched) {
      let persisted: NativeDispatchProof | undefined;
      try {
        persisted = await kernel.requestProof(context, saved.admission.executionRef, b.requestId);
      } catch (error) {
        // PostgreSQL requestProof throws on an absent request ROW. Only that
        // pre-claim absence can bypass the barrier; other SQL failures propagate.
        if (!(error instanceof KernelError) || error.code !== "unknown") {
          throw error;
        }
      }
      if (persisted) {
        b.latched = true;
        b.reached.resolve();
        await b.release.promise;
      }
    }
    return lease;
  };
  let callbackOrigin = "",
    posts = 0,
    entries = 0,
    permits = 0,
    ackCalls = 0;
  let heldResponse: ServerResponse | undefined,
    heldReceipt: Receipt | undefined,
    closeOnCancel = false;
  let resolveEntry: () => void = ignoreEntry;
  const entered = new Promise<void>((resolve) => {
    resolveEntry = resolve;
  });
  const raws: Buffer[] = [],
    records = new Map<string, Receipt>();
  const call = async (route: string, body: unknown, token = credentials.callbackCredential) =>
    fetch(callbackOrigin + "/private/native/v1/" + route, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  const peer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) {
        chunks.push(Buffer.from(c as Uint8Array));
      }
      const raw = Buffer.concat(chunks),
        action = req.url?.slice("/private/native/v1/transports".length) ?? "";
      if (action === "") {
        posts++;
        assert.equal(req.headers.authorization, "Bearer " + credentials.executionCredential);
        raws.push(raw);
        if (mode === "redirect") {
          res.writeHead(307, { location: "/private/native/v1/transports" });
          res.end();
          return;
        }
        const input = JSON.parse(raw.toString()) as NativeInput;
        const native = {
          originRef: "protected-origin",
          engineIncarnation: incarnation,
          requestNonce: randomUUID(),
          generation: input.descriptor.generation,
        };
        const admit = { consumerId: context.consumerId, ...input, native } as NativeInput & {
          payload?: unknown;
          consumerId: string;
          native: NativeDispatchProof["native"];
        };
        delete admit.payload;
        const admitting = call("admit", admit);
        void admitting.catch(() => {});
        let early: Receipt | undefined;
        const b = barrier;
        if (mode === "early-ack" && b?.requestId === input.requestRef) {
          await waitFor(b.reached.promise);
          const p = await kernel.requestProof(
            context,
            input.admission.executionRef,
            input.requestRef,
          );
          assert.ok(p);
          // A sealed reservation has never entered the fixture forwarder. Its
          // no-body/context/return facts are sent through the authenticated TCP
          // callback while the actual facade admit callback is still suspended.
          early = {
            consumerId: context.consumerId,
            executionRef: p.executionRef,
            requestRef: p.requestRef,
            native,
            proof: p,
            phase: "closed",
            effect: "effect_unknown",
            sealed: true,
            acknowledged: false,
            lifetime: {
              entered: false,
              contextDone: true,
              forwardingReturned: true,
              bodyKnown: true,
              bodyClosed: true,
              closeFailed: false,
              completed: false,
              sealed: true,
            },
          };
          records.set(input.requestRef, early);
          const ack = await call("closure-ack", {
            consumerId: context.consumerId,
            proof: p,
            receipt: early,
          });
          assert.equal(ack.status, 200);
          await ack.arrayBuffer();
          early.acknowledged = true;
          b.acked.resolve();
        }
        const response = await admitting;
        assert.equal(response.status, 200);
        const reply = (await response.json()) as {
          dispatch?: { closure: NativeDispatchProof };
          leaseExpiresAt?: string;
          status: { effect: string };
        };
        const duplicate = await call("admit", admit);
        assert.equal(duplicate.status, 200);
        const readback = (await duplicate.json()) as Record<string, unknown>;
        assert.equal("dispatch" in readback, false);
        assert.equal("nativeDescriptor" in readback, false);
        assert.equal("leaseExpiresAt" in readback, false);
        if (!reply.dispatch) {
          res.writeHead(202, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        permits++;
        const p = reply.dispatch.closure;
        assert.ok(isNonemptyString(reply.leaseExpiresAt));
        const equivalent = reply.leaseExpiresAt.replace(
          /\.(\d{3})Z$/,
          (_, ms: string) => "." + ms + "000000Z",
        );
        const extension = reply.leaseExpiresAt.replace(
          /\.(\d{3})Z$/,
          (_, ms: string) => "." + ms + "000001Z",
        );
        assert.equal(
          (
            await call("dispatch-proof", {
              consumerId: context.consumerId,
              proof: p,
              leaseExpiresAt: equivalent,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call("dispatch-proof", {
              consumerId: context.consumerId,
              proof: p,
              leaseExpiresAt: extension,
            })
          ).status,
          403,
        );
        const didEnter = !["noentry", "lost-admit-ack", "early-ack"].includes(mode);
        if (didEnter) {
          entries++;
        }
        const r: Receipt = early ?? {
          consumerId: context.consumerId,
          executionRef: input.admission.executionRef,
          requestRef: input.requestRef,
          native,
          proof: p,
          phase: "closed",
          effect: didEnter ? "completed" : "effect_unknown",
          sealed: true,
          acknowledged: false,
          lifetime: {
            entered: didEnter,
            contextDone: !["unclosed", "held"].includes(mode),
            forwardingReturned: mode !== "held",
            bodyKnown: true,
            bodyClosed: !["closeFailed", "held"].includes(mode),
            closeFailed: mode === "closeFailed",
            completed:
              didEnter &&
              !["partial", "overflow", "unclosed", "closeFailed", "held"].includes(mode),
            sealed: true,
          },
        };
        if (["unclosed", "closeFailed", "held"].includes(mode)) {
          r.phase = "entered";
        }
        if (!r.lifetime.completed) {
          r.effect = "effect_unknown";
        }
        if (mode === "lost-admit-ack") {
          delete r.proof;
        }
        records.set(input.requestRef, r);
        if (!didEnter) {
          // First receipt may precede ContextDone. Same-proof readback supplies
          // later positive closure; cached claim status remains dispatch_started.
          res.writeHead(202, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...r,
              ...(mode === "lost-admit-ack" ? { proof: undefined } : {}),
              phase: "admitted",
              lifetime: { ...r.lifetime, contextDone: false },
              status: reply.status,
            }),
          );
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-gateway-request-ref": input.requestRef,
        });
        res.write("data: fixture\n\n");
        resolveEntry();
        if (mode === "held") {
          heldResponse = res;
          heldReceipt = r;
          return;
        }
        if (mode === "partial") {
          res.flushHeaders();
          setTimeout(() => res.destroy(), 10);
          return;
        }
        if (mode === "overflow") {
          res.write(Buffer.alloc(limits.outputBytes + 1, 0x20));
        }
        if (mode === "large") {
          const closed = new AbortController(),
            onClose = () => {
              closed.abort();
            };
          res.once("close", onClose);
          try {
            for (const frame of streamFrames) {
              if (res.destroyed) {
                return;
              }
              if (!res.write(frame)) {
                await once(res, "drain", { signal: closed.signal });
              }
            }
          } finally {
            res.removeListener("close", onClose);
          }
        }
        res.end();
        return;
      }
      const input = JSON.parse(raw.toString()) as { proof: NativeDispatchProof; cleanup?: unknown },
        p = input.proof;
      const delegate = !action.endsWith("-owner");
      assert.equal(
        req.headers.authorization,
        "Bearer " + (delegate ? credentials.cleanupCredential : credentials.executionCredential),
      );
      const r = records.get(p.requestRef);
      assert.ok(r);
      const authorized = await call(delegate ? "cleanup-authority" : "owner-closure-authority", {
        consumerId: context.consumerId,
        proof: p,
        ...(delegate ? { cleanup: input.cleanup } : {}),
      });
      if (authorized.status !== 200) {
        res.writeHead(403);
        res.end("{}");
        return;
      }
      if (delegate && action === "/cancel" && closeOnCancel) {
        r.phase = "closed";
        r.lifetime.contextDone = true;
        r.lifetime.forwardingReturned = true;
        r.lifetime.bodyKnown = true;
        r.lifetime.bodyClosed = true;
        r.lifetime.closeFailed = false;
      }
      // Same original proof can attach to a sealed lost-ACK reservation. This
      // synthetic peer never changes its entry count or re-admits on attachment.
      if (!r.proof) {
        assert.equal(p.worker, worker);
        assert.deepEqual(p.native, r.native);
        r.proof = p;
      }
      if (action.startsWith("/ack")) {
        // Native caches an already authenticated durable ACK. A late permit
        // cannot cause a second closure callback to hide the attachment race.
        if (mode === "early-ack" && r.acknowledged) {
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
          return;
        }
        ackCalls++;
        const ack = await call("closure-ack", {
          consumerId: context.consumerId,
          proof: p,
          receipt: r,
          ...(delegate ? { cleanup: input.cleanup } : {}),
        });
        if (ack.status !== 200) {
          res.writeHead(403);
          res.end("{}");
          return;
        }
        r.acknowledged = true;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...r, proof: p }));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("{}");
    });
  });
  const nativeOrigin = await listen(peer);
  const authority = new NativeAuthority({
    kernel,
    store,
    config: {
      origin: nativeOrigin,
      enrollment: {
        originRef: "protected-origin",
        engineIncarnation: incarnation,
        worker,
        qualificationRef: profile.qualificationRef,
      },
      consumers: [{ consumerId: context.consumerId, ...credentials }],
      profiles: [
        {
          ...profile,
          requestBytes: 4096,
          outputBytes: executionLimits.outputBytes,
          tokens: 100,
          providerTokenUpperBound: 1000,
        },
      ],
      timeoutMs: options.timeoutMs ?? (mode === "early-ack" ? 5000 : 1000),
      closureWaitMs: 50,
      maxPending: options.maxPending,
    },
  });
  const callbackBudget = new NativeControlAdmission(8, 22);
  const callbacks = authority.createServer((req, res, work) => {
    admitNativeCallback(callbackBudget, req, res, work);
  });
  callbackOrigin = await listen(callbacks);
  const callbackServers = [callbacks];
  const enrollment = await call("enrollment", {
    originRef: "protected-origin",
    engineIncarnation: incarnation,
    qualificationRef: profile.qualificationRef,
  });
  assert.equal(enrollment.status, 200);
  assert.deepEqual(await enrollment.json(), { ok: true });
  const transport = new NativeHTTPTransport(authority);
  const facadeTransport: NativeTransport =
    mode === "large"
      ? {
          request: async (input) => {
            const response = await transport.request(input);
            if (response.kind !== "stream") {
              return response;
            }
            return {
              ...response,
              body: (async function* () {
                // Real native HTTP has already arrived while the consumer is paused.
                // Node 24 may coalesce multiple reads beyond its 64-KiB high-water mark.
                await delay(30);
                for await (const chunk of response.body) {
                  transportChunkSizes.push(chunk.byteLength);
                  yield chunk;
                }
              })(),
            };
          },
          cancel: transport.cancel.bind(transport),
        }
      : transport;
  const management = new AccountManagement({
    kernel,
    store,
    worker,
    custody: new IntentSecrets(randomBytes(32), randomBytes(32)),
    profiles: [profile],
    native: new NativeManagementClient({
      origin: nativeOrigin,
      consumerId: context.consumerId,
      controlCredential: "test-fixture-literal",
    }),
    proof: {
      async verify() {
        return true;
      },
    },
  });
  const bearer = "test-fixture-literal-facade";
  const facade = createFacade({
    kernel,
    management,
    store,
    transport: facadeTransport,
    enrollment: authority.configuration.enrollment,
    bearers: new FacadeBearers([
      { role: "execution", consumerId: context.consumerId, token: bearer, saved },
    ]),
    profiles: [
      {
        dto: {
          profileId: profile.profile,
          protocol: "openai-responses",
          modelIds: [profile.model],
          authKinds: ["api_key"],
        },
        maxOutputTokens: 1000,
      },
    ],
    intentHmacKey: randomBytes(32),
    timeoutMs: Math.max(5000, options.timeoutMs ?? 0),
  });
  const origin = await listen(facade);
  const { executionRef: _ref, issuerEpoch: _issuer, ...publicAdmission } = saved.admission;
  const request = async (
    requestId: string = randomUUID(),
    body: Uint8Array = payload,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      origin + "/v1/executions/" + saved.admission.executionRef + "/requests",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + bearer,
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-gateway-request-id": requestId,
          "x-gateway-admission": JSON.stringify(publicAdmission),
        },
        body: Buffer.from(body),
        signal,
      },
    );
    let failed = response.status !== 200 && response.status !== 202;
    let bytes: Buffer | undefined;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      failed = true;
    }
    return { requestId, response, failed, bytes };
  };
  const occupied = async (requestId: string) =>
    (
      await pool.query<{ transport_occupied: boolean }>(
        "SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND id=$2",
        [context.consumerId, requestId],
      )
    ).rows[0].transport_occupied;
  return {
    context,
    kernel,
    store,
    worker,
    saved,
    authority,
    transport,
    call,
    callbackOrigin,
    records,
    raws,
    request,
    occupied,
    entered,
    expectedStream,
    transportChunkSizes,
    armBarrier: (id: string) => {
      barrier = admissionBarrier(id);
      return barrier;
    },
    releaseHeld: () => {
      assert.ok(heldResponse && heldReceipt);
      heldReceipt.phase = "closed";
      heldReceipt.effect = "completed";
      Object.assign(heldReceipt.lifetime, {
        contextDone: true,
        forwardingReturned: true,
        bodyClosed: true,
        completed: true,
      });
      mode = "complete";
      heldResponse.end();
    },
    enableCancelClosure: () => {
      closeOnCancel = true;
    },
    delegate: async (delegateWorker: string) => {
      const delegateAuthority = new NativeAuthority({
        kernel,
        store,
        config: {
          ...authority.configuration,
          enrollment: { ...authority.configuration.enrollment, worker: delegateWorker },
        },
      });
      const listener = delegateAuthority.createServer((req, res, work) => {
        admitNativeCallback(callbackBudget, req, res, work);
      });
      callbackServers.push(listener);
      callbackOrigin = await listen(listener);
      return new NativeHTTPTransport(delegateAuthority);
    },
    stats: () => ({ posts, entries, permits, ackCalls }),
    stop: async () => {
      barrier?.release.resolve();
      await stop(facade);
      for (const listener of callbackServers) {
        await stop(listener);
      }
      await stop(peer);
      await callbackBudget.stop();
    },
  };
}

void test(
  "synthetic TCP/SQL: coalesced native HTTP reads preserve bounded delivery, exact bytes and acknowledged EOF",
  { timeout: 15_000 },
  async () => {
    const f = await fixture("large", { timeoutMs: 5000 });
    try {
      const result = await f.request();
      assert.equal(result.response.status, 200);
      assert.equal(
        result.failed,
        false,
        "a valid accepted stream must reach client EOF after delayed initial reading",
      );
      assert.ok(result.bytes);
      assert.ok(
        result.bytes.byteLength > 65_536,
        "the real TCP stream exceeds one delivery buffer",
      );
      assert.equal(
        Buffer.compare(result.bytes, f.expectedStream),
        0,
        "every original stream byte arrives in order",
      );
      assert.ok(f.transportChunkSizes.length > 1);
      assert.ok(
        f.transportChunkSizes.every((size) => size > 0 && size <= 65_536),
        "every actual transport yield respects the existing facade buffer bound",
      );
      assert.equal(
        f.transportChunkSizes.reduce((sum, size) => sum + size, 0),
        f.expectedStream.byteLength,
      );
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, result.requestId))
          .effect,
        "completed",
      );
      assert.equal(await f.occupied(result.requestId), false);
      const receipt = f.records.get(result.requestId);
      assert.ok(receipt);
      assert.equal(receipt.phase, "closed");
      assert.equal(receipt.acknowledged, true);
      assert.deepEqual(
        receipt.proof,
        await f.kernel.requestProof(f.context, f.saved.admission.executionRef, result.requestId),
      );
      assert.deepEqual(f.stats(), { posts: 1, entries: 1, permits: 1, ackCalls: 1 });
    } finally {
      await f.stop();
    }
  },
);

void test(
  "synthetic TCP/SQL: trusted preparation, first byte and terminal EOF survive a saturated data checkout lane",
  { timeout: 15_000 },
  async () => {
    const f = await fixture("held", { timeoutMs: 5000 }),
      reached = latch(),
      resume = latch();
    const savedExecution = f.kernel.savedExecution.bind(f.kernel);
    let initial = true;
    f.kernel.savedExecution = async (...args: Parameters<typeof savedExecution>) => {
      const saved = await savedExecution(...args);
      // Pause only after the real ingress transaction has released its checkout.
      // NativeAuthority must still perform its independent original validation.
      if (initial) {
        initial = false;
        reached.resolve();
        await resume.promise;
      }
      return saved;
    };
    const requestId = randomUUID(),
      request = f.request(requestId);
    void request.catch(() => {});
    const held: PoolClient[] = [],
      waiting: Promise<void>[] = [];
    try {
      await waitFor(reached.promise);
      const checkout = sharedCheckout(pool);
      held.push(
        ...(await Promise.all(Array.from({ length: 6 }, () => inServiceLane("data", checkout)))),
      );
      const backends = await Promise.all(
        held.map((client) => client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")),
      );
      assert.equal(
        new Set(backends.map((result) => result.rows[0].pid)).size,
        6,
        "six real physical data clients",
      );
      for (let n = 0; n < 8; n++) {
        const pending = inServiceLane("data", checkout).then((client) => {
          client.release();
          return;
        });
        void pending.catch(() => {});
        waiting.push(pending);
      }
      await assert.rejects(
        inServiceLane("data", checkout),
        (error: unknown) => error instanceof KernelError && error.code === "unavailable",
      );
      resume.resolve();
      await waitFor(f.entered);
      f.releaseHeld();
      const result = await request;
      assert.equal(result.response.status, 200);
      assert.equal(result.failed, false, "HTTP EOF arrives while data checkouts remain saturated");
      assert.equal(
        (
          await inServiceLane("control", () =>
            f.kernel.request(f.context, f.saved.admission.executionRef, requestId),
          )
        ).effect,
        "completed",
      );
      assert.equal(await f.occupied(requestId), false);
      const receipt = f.records.get(requestId);
      assert.ok(receipt);
      assert.equal(receipt.phase, "closed");
      assert.equal(receipt.acknowledged, true);
      assert.deepEqual(f.stats(), { posts: 1, entries: 1, permits: 1, ackCalls: 1 });
    } finally {
      resume.resolve();
      held.forEach((client) => {
        client.release();
      });
      await Promise.allSettled(waiting);
      await f.stop();
      await request.catch(() => {});
    }
  },
);

void test("synthetic TCP/SQL: positive owner closure releases concurrency1 for two requests in the SAME OPEN execution", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const r = await f.request();
      assert.equal(r.failed, false);
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId)).effect,
        "completed",
      );
      assert.equal(await f.occupied(r.requestId), false);
      assert.equal(
        (await f.kernel.execution(f.context, f.saved.admission.executionRef)).state,
        "open",
      );
    }
    assert.deepEqual(f.stats(), { posts: 2, entries: 2, permits: 2, ackCalls: 2 });
    assert.equal(
      (
        await pool.query<{ request_count: number }>(
          "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
          [f.context.consumerId, f.saved.admission.executionRef],
        )
      ).rows[0].request_count,
      2,
    );
    for (const raw of f.raws) {
      const prefix = Buffer.from(',"payload":'),
        start = raw.indexOf(prefix) + prefix.length;
      assert.deepEqual(raw.subarray(start, raw.length - 1), payload);
      assert.equal(
        (JSON.parse(raw.toString()) as NativeInput).descriptor.created_at,
        "2026-10-03T04:05:06.123456789Z",
      );
    }
  } finally {
    await f.stop();
  }
});
void test("synthetic TCP/SQL: EOF, CloseFailed, partial and output cap retain occupancy and fence fresh request IDs", async () => {
  for (const mode of ["unclosed", "closeFailed", "partial", "overflow"] as const) {
    const f = await fixture(mode);
    try {
      const r = await f.request();
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId)).effect,
        "effect_unknown",
      );
      if (mode === "unclosed" || mode === "closeFailed") {
        assert.equal(await f.occupied(r.requestId), true);
      }
      const again = await f.request();
      assert.equal(again.failed, true);
      assert.equal(f.stats().posts, 1);
      assert.equal(f.stats().entries, 1);
    } finally {
      await f.stop();
    }
  }
});
void test("synthetic TCP/SQL: exact positive no-entry and sealed lost admit ACK spend one claim, never enter, then close independently", async () => {
  for (const mode of ["noentry", "lost-admit-ack"] as const) {
    const f = await fixture(mode);
    try {
      const r = await f.request();
      assert.equal(r.failed, false);
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId)).effect,
        "rejected_before_dispatch",
      );
      assert.equal(await f.occupied(r.requestId), false);
      assert.equal(f.stats().entries, 0);
      assert.equal(f.stats().permits, 1);
      assert.equal(f.stats().posts, 1);
      await f.request(r.requestId);
      assert.equal(f.stats().posts, 1);
      assert.equal(
        (
          await pool.query<{ request_count: number }>(
            "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [f.context.consumerId, f.saved.admission.executionRef],
          )
        ).rows[0].request_count,
        1,
      );
    } finally {
      await f.stop();
    }
  }
});
void test("synthetic TCP/SQL: expired original owner may ACK immutable completed proof but cannot dispatch; foreign authority denies", async () => {
  const f = await fixture();
  try {
    const r = await f.request(),
      native = f.records.get(r.requestId);
    assert.ok(native?.proof);
    const p = native.proof;
    await pool.query(
      "UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
      [f.context.consumerId, f.worker],
    );
    assert.equal(
      (await f.call("owner-closure-authority", { consumerId: f.context.consumerId, proof: p }))
        .status,
      200,
    );
    assert.equal(
      (
        await f.call("dispatch-proof", {
          consumerId: f.context.consumerId,
          proof: p,
          leaseExpiresAt: new Date(Date.now() + 100).toISOString(),
        })
      ).status,
      403,
    );
    const ack = await f.call("closure-ack", {
      consumerId: f.context.consumerId,
      proof: p,
      receipt: native,
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { ok: true });
    assert.equal(
      (await f.call("closure-ack", { consumerId: f.context.consumerId, proof: p, receipt: native }))
        .status,
      200,
    );
    assert.equal(await f.occupied(r.requestId), false);
    assert.deepEqual(await f.kernel.requestProof(f.context, p.executionRef, p.requestRef), p);
    for (const changed of [
      { ...p, token: randomUUID() },
      { ...p, worker: randomUUID() },
      { ...p, native: { ...p.native, engineIncarnation: randomUUID() } },
    ]) {
      assert.equal(
        (
          await f.call("owner-closure-authority", {
            consumerId: f.context.consumerId,
            proof: changed,
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (await f.call("owner-closure-authority", { consumerId: "foreign-consumer", proof: p }))
        .status,
      403,
    );
    assert.equal(
      (await f.kernel.request(f.context, p.executionRef, p.requestRef)).effect,
      "completed",
    );
  } finally {
    await f.stop();
  }
});
void test(
  "synthetic TCP/SQL: owner closure before delegated ACK preserves exact claimed and done retries",
  { timeout: 30_000 },
  async () => {
    const f = await fixture("held");
    try {
      const requestId = randomUUID(),
        pending = f.request(requestId);
      void pending.catch(() => {});
      await waitFor(f.entered);
      const p = await f.kernel.requestProof(f.context, f.saved.admission.executionRef, requestId);
      assert.ok(p);
      assert.equal(await f.occupied(requestId), true);
      await f.kernel.close(f.context, randomUUID(), p.executionRef);
      const job = await f.kernel.claimCleanup(f.context, f.worker);
      assert.ok(job && job.scope.kind === "execution");
      assert.equal(job.scope.executionRef, p.executionRef);
      assert.deepEqual(job.scope.transports, [p]);
      const leaseExpiresAt = await f.kernel.currentCleanupLease(
        f.context,
        job.cleanupRef,
        f.worker,
        job.token,
      );
      const c = { cleanupRef: job.cleanupRef, worker: f.worker, token: job.token, leaseExpiresAt };
      assert.equal(
        (
          await f.call("cleanup-authority", {
            consumerId: f.context.consumerId,
            proof: p,
            cleanup: c,
          })
        ).status,
        200,
      );
      const openReceipt = structuredClone(f.records.get(requestId));
      assert.ok(openReceipt);
      // Let the existing peer finish the held body and the real owner transport
      // complete its authenticated ACK before sending the delegated duplicate.
      f.releaseHeld();
      assert.equal((await pending).failed, false);
      const receipt = f.records.get(requestId);
      assert.ok(receipt?.acknowledged === true);
      assert.equal(f.stats().ackCalls, 1);
      assert.equal(await f.occupied(requestId), false);
      const status = await f.kernel.request(f.context, p.executionRef, requestId);
      assert.equal(status.effect, "completed");

      const other = await f.kernel.prepare(f.context, {
        operationId: randomUUID(),
        intentDigest: "other-ack-scope",
        invocationRef: randomUUID(),
        attemptRef: "other-attempt",
        permittedAccounts: [f.saved.admission.accountRef],
        profile: profile.profile,
        policySubject: "binding-fixture",
        policyRevision: 2,
        bindingRevision: 3,
        issuerEpoch: f.saved.admission.issuerEpoch,
        deadline: new Date(Date.now() + 10_000),
        limits,
      });
      assert.ok(isNonemptyString(other.executionRef));
      await f.kernel.close(f.context, randomUUID(), other.executionRef);
      const otherJob = await f.kernel.claimCleanup(f.context, f.worker);
      assert.ok(otherJob && otherJob.scope.kind === "execution");
      assert.equal(otherJob.scope.executionRef, other.executionRef);
      const otherLease = {
        cleanupRef: otherJob.cleanupRef,
        worker: f.worker,
        token: otherJob.token,
        leaseExpiresAt: await f.kernel.currentCleanupLease(
          f.context,
          otherJob.cleanupRef,
          f.worker,
          otherJob.token,
        ),
      };
      assert.match(leaseExpiresAt, /\.\d{6}Z$/);
      const equivalent = leaseExpiresAt.replace(/Z$/, "000+00:00");
      const offset =
        new Date(new Date(leaseExpiresAt.slice(0, 19) + "Z").getTime() + 3_600_000)
          .toISOString()
          .slice(0, 19) +
        leaseExpiresAt.slice(19, -1) +
        "000+01:00";
      const extension = leaseExpiresAt.replace(/Z$/, "001Z"); // Exactly +1ns, below PostgreSQL precision.
      const { leaseExpiresAt: _lease, ...missingLease } = c;
      const ack = async (
        cleanup: unknown,
        expected: number,
        closed: unknown = receipt,
        original: unknown = p,
        consumerId = f.context.consumerId,
        token = credentials.callbackCredential,
      ) => {
        const response = await f.call(
          "closure-ack",
          { consumerId, proof: original, receipt: closed, cleanup },
          token,
        );
        assert.equal(response.status, expected);
        assert.deepEqual(
          await response.json(),
          expected === 200 ? { ok: true } : { code: "denied" },
        );
      };
      for (const state of ["claimed", "done"] as const) {
        if (state === "done") {
          await f.kernel.settleCleanup(f.context, job.cleanupRef, f.worker, job.token, true);
        }
        assert.equal(
          (
            await pool.query<{ state: string }>(
              "SELECT state FROM ag_kernel.cleanup WHERE consumer=$1 AND ref=$2",
              [f.context.consumerId, job.cleanupRef],
            )
          ).rows[0].state,
          state,
        );
        await ack(c, 200);
        await ack(c, 200);
        await ack({ ...c, leaseExpiresAt: equivalent }, 200);
        await ack({ ...c, leaseExpiresAt: offset }, 200);
        for (const changed of [
          missingLease,
          { ...c, leaseExpiresAt: null },
          { ...c, leaseExpiresAt: "forged" },
          { ...c, leaseExpiresAt: extension },
          { ...c, token: randomUUID() },
          { ...c, worker: randomUUID() },
          { ...c, cleanupRef: randomUUID() },
          otherLease,
        ]) {
          await ack(changed, 403);
        }
        await ack(c, 403, openReceipt);
        await ack(c, 403, { ...receipt, lifetime: { ...receipt.lifetime, closeFailed: true } });
        await ack(c, 403, { ...receipt, proof: { ...p, token: randomUUID() } });
        for (const changed of [
          { ...p, executionRef: other.executionRef },
          { ...p, requestRef: "foreign-request" },
          { ...p, worker: randomUUID() },
          { ...p, token: randomUUID() },
          { ...p, native: { ...p.native, requestNonce: randomUUID() } },
        ]) {
          await ack(c, 403, receipt, changed);
        }
        await ack(c, 403, receipt, p, "foreign-consumer");
        await ack(c, 403, receipt, p, f.context.consumerId, credentials.cleanupCredential);
        // A closure retry never grants read/dispatch authority for an unoccupied
        // transport, even while this exact cleanup lease is still claimed/live.
        assert.equal(
          (
            await f.call("cleanup-authority", {
              consumerId: f.context.consumerId,
              proof: p,
              cleanup: c,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await f.call("dispatch-proof", {
              consumerId: f.context.consumerId,
              proof: p,
              leaseExpiresAt,
            })
          ).status,
          403,
        );
        assert.equal(await f.occupied(requestId), false);
        assert.deepEqual(await f.kernel.requestProof(f.context, p.executionRef, requestId), p);
        assert.deepEqual(await f.kernel.request(f.context, p.executionRef, requestId), status);
        assert.equal(
          (
            await pool.query<{ request_count: number }>(
              "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
              [f.context.consumerId, p.executionRef],
            )
          ).rows[0].request_count,
          1,
        );
      }
      // Done readback is harmless after lease expiry only with its exact instant.
      const expired = (
        await pool.query<{ expires: string }>(
          `UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second'
      WHERE consumer=$1 AND ref=$2 RETURNING to_char(lease_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires`,
          [f.context.consumerId, job.cleanupRef],
        )
      ).rows[0].expires;
      await ack({ ...c, leaseExpiresAt: expired }, 200);
      await ack(c, 403);
      assert.equal(await f.occupied(requestId), false);
      assert.deepEqual(await f.kernel.requestProof(f.context, p.executionRef, requestId), p);
      assert.deepEqual(await f.kernel.request(f.context, p.executionRef, requestId), status);
      assert.deepEqual(f.stats(), { posts: 1, entries: 1, permits: 1, ackCalls: 1 });
    } finally {
      await f.stop();
    }
  },
);
void test("synthetic TCP/SQL: an expired claimed lease denies an exact delegated duplicate with genuine closed receipt", async () => {
  const f = await fixture();
  try {
    const r = await f.request();
    assert.equal(r.failed, false);
    const receipt = f.records.get(r.requestId);
    assert.ok(receipt?.proof && receipt.acknowledged);
    const p = receipt.proof;
    await f.kernel.close(f.context, randomUUID(), p.executionRef);
    const job = await f.kernel.claimCleanup(f.context, f.worker);
    assert.ok(job && job.scope.kind === "execution");
    assert.equal(job.scope.executionRef, p.executionRef);
    const expired = (
      await pool.query<{ expires: string }>(
        `UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second'
      WHERE consumer=$1 AND ref=$2 RETURNING to_char(lease_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires`,
        [f.context.consumerId, job.cleanupRef],
      )
    ).rows[0].expires;
    const cleanup = {
      cleanupRef: job.cleanupRef,
      worker: f.worker,
      token: job.token,
      leaseExpiresAt: expired,
    };
    assert.equal(
      (
        await f.call("closure-ack", {
          consumerId: f.context.consumerId,
          proof: p,
          receipt,
          cleanup,
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.call("cleanup-authority", { consumerId: f.context.consumerId, proof: p, cleanup }))
        .status,
      403,
    );
    assert.equal(await f.occupied(r.requestId), false);
    assert.deepEqual(await f.kernel.requestProof(f.context, p.executionRef, r.requestId), p);
    assert.equal(
      (await f.kernel.request(f.context, p.executionRef, r.requestId)).effect,
      "completed",
    );
  } finally {
    await f.stop();
  }
});
void test("synthetic TCP/SQL: delegate needs the actual current cleanup row/token/execution scope; no guessed expiry", async () => {
  const f = await fixture("unclosed");
  try {
    const r = await f.request(),
      p = await f.kernel.requestProof(f.context, f.saved.admission.executionRef, r.requestId);
    assert.ok(p);
    const job = await f.kernel.claimCleanup(f.context, f.worker);
    assert.ok(job && job.scope.kind === "execution");
    const leaseExpiresAt = await f.kernel.currentCleanupLease(
      f.context,
      job.cleanupRef,
      f.worker,
      job.token,
    );
    const c = { cleanupRef: job.cleanupRef, worker: f.worker, token: job.token, leaseExpiresAt };
    assert.equal(
      (
        await f.call("cleanup-authority", {
          consumerId: f.context.consumerId,
          proof: p,
          cleanup: c,
        })
      ).status,
      200,
    );
    for (const changed of [
      { ...c, token: randomUUID() },
      { ...c, cleanupRef: randomUUID() },
      { ...c, leaseExpiresAt: new Date(Date.now() + 10_000).toISOString() },
    ]) {
      assert.equal(
        (
          await f.call("cleanup-authority", {
            consumerId: f.context.consumerId,
            proof: p,
            cleanup: changed,
          })
        ).status,
        403,
      );
    }
    const other = await f.kernel.prepare(f.context, {
      operationId: randomUUID(),
      intentDigest: "other-fixture",
      invocationRef: randomUUID(),
      attemptRef: "other-attempt",
      permittedAccounts: [f.saved.admission.accountRef],
      profile: profile.profile,
      policySubject: "binding-fixture",
      policyRevision: 2,
      bindingRevision: 3,
      issuerEpoch: f.saved.admission.issuerEpoch,
      deadline: new Date(Date.now() + 10_000),
      limits,
    });
    assert.ok(isNonemptyString(other.executionRef));
    await f.kernel.close(f.context, randomUUID(), other.executionRef);
    const otherJob = await f.kernel.claimCleanup(f.context, f.worker);
    assert.ok(otherJob && otherJob.scope.kind === "execution");
    assert.equal(otherJob.scope.executionRef, other.executionRef);
    const otherLease = {
      cleanupRef: otherJob.cleanupRef,
      worker: f.worker,
      token: otherJob.token,
      leaseExpiresAt: await f.kernel.currentCleanupLease(
        f.context,
        otherJob.cleanupRef,
        f.worker,
        otherJob.token,
      ),
    };
    assert.equal(
      (
        await f.call("cleanup-authority", {
          consumerId: f.context.consumerId,
          proof: p,
          cleanup: otherLease,
        })
      ).status,
      403,
    );
    const receipt = f.records.get(r.requestId);
    assert.ok(receipt);
    assert.equal(
      (
        await f.call("closure-ack", {
          consumerId: f.context.consumerId,
          proof: p,
          cleanup: c,
          receipt,
        })
      ).status,
      403,
    );
    await pool.query(
      "UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",
      [f.context.consumerId, job.cleanupRef],
    );
    assert.equal(
      (
        await f.call("cleanup-authority", {
          consumerId: f.context.consumerId,
          proof: p,
          cleanup: c,
        })
      ).status,
      403,
    );
    assert.equal(await f.occupied(r.requestId), true);
  } finally {
    await f.stop();
  }
});
void test("synthetic TCP/SQL: control HTTP rejects duplicate headers, aliases, duplicates, query, body cap and forged enrollment safely", async () => {
  const f = await fixture();
  try {
    const endpoint = new URL(f.callbackOrigin);
    async function raw(
      headers: string[],
      body = "{}",
      route = "/private/native/v1/enrollment",
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        const s = connect({ host: "127.0.0.1", port: Number(endpoint.port) }),
          chunks: Buffer[] = [];
        s.setTimeout(3000, () => {
          s.destroy();
          reject(new Error("fixture timeout"));
        });
        s.on("error", () => {
          resolve(Buffer.concat(chunks).toString());
        });
        s.on("data", (b) => chunks.push(b));
        s.once("end", () => {
          resolve(Buffer.concat(chunks).toString());
        });
        s.once("connect", () =>
          s.write(
            "POST " +
              route +
              " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: " +
              Buffer.byteLength(body) +
              "\r\n" +
              headers.join("\r\n") +
              "\r\n\r\n" +
              body,
          ),
        );
      });
    }
    const auth = "Authorization: Bearer " + credentials.callbackCredential,
      type = "Content-Type: application/json";
    for (const headers of [
      [type],
      [auth, auth, type],
      [auth, type, type],
      [auth, type, "Content-Encoding: identity"],
    ]) {
      const r = await raw(headers);
      assert.match(r, /HTTP\/1.1 403/);
      assert.equal(r.includes(credentials.callbackCredential), false);
    }
    for (const body of [
      '{"originRef":"x","originRef":"y"}',
      '{"OriginRef":"x"}',
      "{}",
      " ".repeat(32_769),
    ]) {
      const r = await raw([auth, type], body);
      assert.ok(!r.includes("HTTP/1.1 200"));
    }
    assert.match(
      await raw([auth, type], "{}", "/private/native/v1/enrollment?x=1"),
      /HTTP\/1.1 403/,
    );
    assert.equal(
      (
        await f.call("enrollment", {
          originRef: "other",
          engineIncarnation: randomUUID(),
          qualificationRef: profile.qualificationRef,
        })
      ).status,
      403,
    );
    assert.equal(f.stats().posts, 0);
  } finally {
    await f.stop();
  }
});
void test("synthetic TCP/SQL: redirects do not replay inference, and uncertainty fences the original execution", async () => {
  const f = await fixture("redirect");
  try {
    await f.request();
    assert.equal(f.stats().posts, 1);
    assert.equal(f.stats().entries, 0);
    assert.equal(
      (await f.kernel.execution(f.context, f.saved.admission.executionRef)).state,
      "closed",
    );
    const again = await f.request();
    assert.equal(again.failed, true);
    assert.equal(f.stats().posts, 1);
  } finally {
    await f.stop();
  }
});
void test("synthetic TCP/SQL: the complete association rejects each tuple/cap, nanosecond birth, nonce and issuer substitution", async () => {
  const f = await fixture();
  try {
    const r = await f.request(),
      original = JSON.parse(f.raws[0].toString()) as NativeInput,
      p = f.records.get(r.requestId)?.proof;
    assert.ok(p);
    const { requestRef, worker, admission, descriptor } = original;
    const tuple = {
      consumerId: f.context.consumerId,
      requestRef,
      worker,
      admission,
      descriptor,
      native: p.native,
    };
    const variants: Partial<PrivateAdmission>[] = [
      { executionRef: randomUUID() },
      { issuerEpoch: randomUUID() },
      { invocationRef: "other" },
      { attemptRef: "other" },
      { accountRef: randomUUID() },
      { authorizationEpoch: 99 },
      { subjectRef: "other" },
      { policyRevision: 99 },
      { bindingRevision: 99 },
      { profileId: "other" },
      {
        expiresAt: admission.expiresAt.replace(
          /\.(\d{3})Z$/,
          (_, ms: string) => "." + ms + "000001Z",
        ),
      },
    ];
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      variants.push({ limits: { ...limits, [key]: limits[key] + 1 } });
    }
    for (const variant of variants) {
      assert.equal(
        (await f.call("admit", { ...tuple, admission: { ...admission, ...variant } })).status,
        403,
      );
    }
    for (const descriptorPatch of [
      { account_id: descriptor.account_id + 1 },
      { generation: randomUUID() },
      { created_at: "2026-10-03T04:05:06.123456788Z" },
      { profile: "openrouter-openai-responses-apikey-v1" },
      { base_url: "https://openrouter.ai/api/v1" },
      { model: "openai/gpt-5.4-mini" },
    ]) {
      assert.equal(
        (await f.call("admit", { ...tuple, descriptor: { ...descriptor, ...descriptorPatch } }))
          .status,
        403,
      );
    }
    assert.equal(
      (await f.call("admit", { ...tuple, native: { ...p.native, requestNonce: randomUUID() } }))
        .status,
      403,
    );
    assert.equal(f.stats().permits, 1);
    assert.equal(f.stats().entries, 1);
    assert.equal(
      (
        await pool.query<{ request_count: number }>(
          "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
          [f.context.consumerId, admission.executionRef],
        )
      ).rows[0].request_count,
      1,
    );
  } finally {
    await f.stop();
  }
});
void test("synthetic TCP/SQL: client abort fences the original attempt and cannot certify held native body closure", async () => {
  const f = await fixture("held");
  try {
    const controller = new AbortController(),
      id = randomUUID();
    const result = f.request(id, payload, controller.signal).catch(() => {});
    await f.entered;
    controller.abort();
    await result;
    for (
      let n = 0;
      n < 50 &&
      (await f.kernel.request(f.context, f.saved.admission.executionRef, id)).effect !==
        "effect_unknown";
      n++
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    assert.equal(
      (await f.kernel.request(f.context, f.saved.admission.executionRef, id)).effect,
      "effect_unknown",
    );
    assert.equal(await f.occupied(id), true);
    await f.request();
    assert.equal(f.stats().entries, 1);
    assert.equal(f.stats().posts, 1);
  } finally {
    await f.stop();
  }
});

void test(
  "synthetic TCP/SQL: current cleanup worker B closes expired original owner A without changing its proof or effect",
  { timeout: 30_000 },
  async () => {
    const f = await fixture("unclosed");
    try {
      const r = await f.request(),
        ref = f.saved.admission.executionRef;
      const original = await f.kernel.requestProof(f.context, ref, r.requestId);
      assert.ok(original);
      assert.equal(original.worker, f.worker);
      assert.equal(await f.occupied(r.requestId), true);
      await pool.query(
        "UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
        [f.context.consumerId, f.worker],
      );
      const workerB = randomUUID();
      await f.kernel.heartbeat(f.context, workerB);
      await f.kernel.reconcile(f.context);
      const job = await f.kernel.claimCleanup(f.context, workerB);
      assert.ok(job && job.scope.kind === "execution");
      assert.equal(job.scope.executionRef, ref);
      assert.deepEqual(
        job.scope.transports.find((p) => p.requestRef === r.requestId),
        original,
      );
      const delegate = await f.delegate(workerB);
      const cleanup = { cleanupRef: job.cleanupRef, token: job.token };
      const lease = {
        ...cleanup,
        worker: workerB,
        leaseExpiresAt: await f.kernel.currentCleanupLease(
          f.context,
          job.cleanupRef,
          workerB,
          job.token,
        ),
      };
      assert.equal(
        (
          await f.call("cleanup-authority", {
            consumerId: f.context.consumerId,
            proof: original,
            cleanup: lease,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call("dispatch-proof", {
            consumerId: f.context.consumerId,
            proof: original,
            leaseExpiresAt: lease.leaseExpiresAt,
          })
        ).status,
        403,
      );
      for (const proof of [
        { ...original, worker: workerB },
        { ...original, token: randomUUID() },
        { ...original, native: { ...original.native, requestNonce: randomUUID() } },
        { ...original, native: { ...original.native, generation: randomUUID() } },
      ]) {
        assert.equal(
          (
            await f.call("cleanup-authority", {
              consumerId: f.context.consumerId,
              proof,
              cleanup: lease,
            })
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await f.call("cleanup-authority", {
            consumerId: f.context.consumerId,
            proof: original,
            cleanup: { ...lease, token: randomUUID() },
          })
        ).status,
        403,
      );
      // A real leased cancel plus the bounded wait alone cannot release SQL occupancy.
      await assert.rejects(delegate.cancel(f.context, original, cleanup));
      assert.equal(await f.occupied(r.requestId), true);
      f.enableCancelClosure();
      await delegate.cancel(f.context, original, cleanup);
      assert.equal(await f.occupied(r.requestId), false);
      assert.deepEqual(await f.kernel.requestProof(f.context, ref, r.requestId), original);
      assert.equal((await f.kernel.request(f.context, ref, r.requestId)).effect, "effect_unknown");
      assert.notEqual((await f.kernel.execution(f.context, ref)).state, "open");
      assert.equal(f.stats().posts, 1);
      assert.equal(f.stats().entries, 1);
      // Closing transport does not rearm the old attempt, but frees account-global
      // capacity for a genuinely fresh approved invocation under B.
      const fresh = await f.kernel.prepare(f.context, {
        operationId: randomUUID(),
        intentDigest: "after-owner-cleanup",
        invocationRef: "fresh-" + randomUUID(),
        attemptRef: "fresh-attempt",
        permittedAccounts: [f.saved.admission.accountRef],
        profile: profile.profile,
        policySubject: "binding-fixture",
        policyRevision: 2,
        bindingRevision: 3,
        issuerEpoch: f.saved.admission.issuerEpoch,
        deadline: new Date(Date.now() + 10_000),
        limits,
      });
      assert.ok(isNonemptyString(fresh.executionRef));
      const saved = await f.kernel.savedExecution(f.context, fresh.executionRef);
      const claim = await f.kernel.claim(
        f.context,
        fresh.executionRef,
        randomUUID(),
        workerB,
        saved.admission,
        {
          originRef: original.native.originRef,
          engineIncarnation: original.native.engineIncarnation,
          requestNonce: randomUUID(),
        },
      );
      assert.ok(claim.dispatch);
      assert.equal(claim.dispatch.closure.worker, workerB);
      await pool.query(
        "UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",
        [f.context.consumerId, job.cleanupRef],
      );
      assert.equal(
        (
          await f.call("cleanup-authority", {
            consumerId: f.context.consumerId,
            proof: original,
            cleanup: lease,
          })
        ).status,
        403,
      );
    } finally {
      await f.stop();
    }
  },
);

void test(
  "synthetic TCP/SQL: repeated safe pre-POST preparation failures leave routing capacity for a fresh request",
  { timeout: 30_000 },
  async () => {
    const f = await fixture("complete", { maxPending: 2 });
    try {
      const mapping = await f.store.mapping(f.context, f.saved.generation);
      assert.ok(mapping);
      await pool.query(
        "DELETE FROM ag_management.physical_mappings WHERE consumer=$1 AND generation=$2",
        [f.context.consumerId, f.saved.generation],
      );
      for (let n = 0; n < 6; n++) {
        assert.equal((await f.request()).failed, true);
      }
      assert.equal(f.stats().posts, 0);
      assert.equal(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM ag_kernel.requests WHERE consumer=$1",
            [f.context.consumerId],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await pool.query<{ request_count: number }>(
            "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [f.context.consumerId, f.saved.admission.executionRef],
          )
        ).rows[0].request_count,
        0,
      );
      await f.store.saveMapping(mapping);
      const fresh = await f.request();
      assert.equal(fresh.failed, false);
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, fresh.requestId)).effect,
        "completed",
      );
      assert.equal(await f.occupied(fresh.requestId), false);
      assert.equal(f.stats().entries, 1);
    } finally {
      await f.stop();
    }
  },
);

void test(
  "synthetic TCP/SQL: no-permit limit refusals beyond maxPending retain SQL tombstones and recover after held closure",
  { timeout: 30_000 },
  async () => {
    const f = await fixture("held", { maxPending: 3, timeoutMs: 10_000 });
    try {
      const heldId = randomUUID(),
        held = f.request(heldId);
      void held.catch(() => {});
      await waitFor(f.entered);
      const denied: string[] = [];
      for (let n = 0; n < 7; n++) {
        const r = await f.request();
        denied.push(r.requestId);
        assert.equal(r.failed, false);
        assert.equal(r.response.status, 202);
        assert.deepEqual(
          await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId),
          { requestRef: r.requestId, effect: "not_dispatched", code: "concurrency_limit" },
        );
        assert.equal(
          await f.kernel.requestProof(f.context, f.saved.admission.executionRef, r.requestId),
          undefined,
        );
        assert.equal(await f.occupied(r.requestId), false);
      }
      assert.equal(await f.occupied(heldId), true);
      assert.equal(
        (
          await pool.query<{ request_count: number }>(
            "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [f.context.consumerId, f.saved.admission.executionRef],
          )
        ).rows[0].request_count,
        1,
      );
      f.releaseHeld();
      assert.equal((await held).failed, false);
      assert.equal(await f.occupied(heldId), false);
      const fresh = await f.request();
      assert.equal(fresh.failed, false);
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, fresh.requestId)).effect,
        "completed",
      );
      // Evicting volatile routes must never forget durable no-spend denials.
      await f.request(denied[0]);
      assert.equal(
        (await f.kernel.request(f.context, f.saved.admission.executionRef, denied[0])).effect,
        "not_dispatched",
      );
      assert.equal(f.stats().entries, 2);
      assert.equal(f.stats().permits, 2);
      assert.equal(
        (
          await pool.query<{ request_count: number }>(
            "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [f.context.consumerId, f.saved.admission.executionRef],
          )
        ).rows[0].request_count,
        2,
      );
      assert.equal(
        (await f.kernel.execution(f.context, f.saved.admission.executionRef)).state,
        "open",
      );
    } finally {
      await f.stop();
    }
  },
);

void test(
  "synthetic TCP/SQL: authenticated ACK before actual facade callback returns proof is reusable without re-admit or second closure callback",
  { timeout: 30_000 },
  async () => {
    const f = await fixture("early-ack", { maxPending: 2 });
    try {
      for (let n = 0; n < 3; n++) {
        const id = randomUUID(),
          barrier = f.armBarrier(id),
          pending = f.request(id);
        void pending.catch(() => {});
        try {
          await waitFor(barrier.acked.promise);
          assert.equal(await f.occupied(id), false);
          assert.equal(
            (await f.kernel.request(f.context, f.saved.admission.executionRef, id)).effect,
            "dispatch_started",
          );
          const original = JSON.parse(f.raws[n].toString()) as NativeInput;
          const p = await f.kernel.requestProof(f.context, f.saved.admission.executionRef, id);
          assert.ok(p);
          const duplicate = await f.call("admit", {
            consumerId: f.context.consumerId,
            requestRef: id,
            worker: original.worker,
            admission: original.admission,
            descriptor: original.descriptor,
            native: p.native,
          });
          assert.equal(duplicate.status, 200);
          const reply = (await duplicate.json()) as Record<string, unknown>;
          assert.equal("dispatch" in reply, false);
          assert.equal("leaseExpiresAt" in reply, false);
          assert.equal(f.stats().entries, 0);
          assert.equal(f.stats().permits, n);
          assert.equal(
            (
              await pool.query<{ request_count: number }>(
                "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
                [f.context.consumerId, f.saved.admission.executionRef],
              )
            ).rows[0].request_count,
            n + 1,
          );
        } finally {
          barrier.release.resolve();
        }
        assert.equal((await pending).failed, false);
        assert.equal(
          (await f.kernel.request(f.context, f.saved.admission.executionRef, id)).effect,
          "rejected_before_dispatch",
        );
        await f.request(id);
        assert.equal(f.stats().posts, n + 1);
      }
      assert.deepEqual(f.stats(), { posts: 3, entries: 0, permits: 3, ackCalls: 0 });
      assert.equal(
        (await f.kernel.execution(f.context, f.saved.admission.executionRef)).state,
        "open",
      );
    } finally {
      await f.stop();
    }
  },
);
