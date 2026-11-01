// Real ephemeral TCP transport/callback paths; no SQL, native binary or provider.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { KernelError } from "../src/domain.ts";
import type { SavedExecution } from "../src/domain.ts";
import { NativeAuthority } from "../src/native-authority.ts";
import type { AuthorityOptions } from "../src/native-authority.ts";
import { NativeHTTPTransport } from "../src/native-transport.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function failure(code: KernelError["code"]) {
  const error = new KernelError(code);
  error.message = "SECRET_SENTINEL";
  return error;
}
async function fixture(reply: (res: ServerResponse) => void) {
  let posts = 0, claims = 0;
  const closeFences = new Set<string>();
  let prepareError: KernelError | undefined, recoveryError: KernelError | undefined;
  const native = createServer((req, res) => {
    void (async () => {
      for await (const _ of req) { /* Drain fixture input. */ }
      posts++;
      reply(res);
    })();
  });
  const origin = await listen(native);
  const generation = randomUUID(), worker = randomUUID();
  const profile = { profile: "loopback-profile", baseURL: "https://fixture.invalid/v1",
    model: "fixture-model", qualificationRef: "loopback-only" };
  const saved: SavedExecution = {
    generation, state: "open", dispatchAllowed: true,
    admission: {
      executionRef: randomUUID(), issuerEpoch: randomUUID(), accountRef: randomUUID(),
      invocationRef: "fixture-invocation", attemptRef: "fixture-attempt", subjectRef: "fixture-subject",
      authorizationEpoch: 1, policyRevision: 1, bindingRevision: 1, profileId: profile.profile,
      limits: { requests: 1, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const kernel = {
    async savedExecution() { if (prepareError) throw prepareError; return saved; },
    async currentWorkerLease() { return saved.admission.expiresAt; },
    async requestProof() { if (recoveryError) throw recoveryError; return undefined; },
    async close(_context: unknown, closeRef: string) { closeFences.add(closeRef); },
  };
  const authority = new NativeAuthority({
    kernel: kernel as unknown as AuthorityOptions["kernel"],
    store: { async mapping() { return {
      consumerId: "fixture-consumer", operationId: "fixture-operation", ownerRef: "fixture-owner",
      accountRef: saved.admission.accountRef, purpose: "create", generation, worker, profile,
      descriptor: { generation, nativePhysicalIdentity: generation, nativeId: 1,
        createdAt: "2026-10-03T04:05:06Z", profile: profile.profile, baseURL: profile.baseURL, model: profile.model },
    }; } },
    config: {
      origin, enrollment: { originRef: "fixture-origin", engineIncarnation: "fixture-engine", worker,
        qualificationRef: profile.qualificationRef },
      consumers: [{ consumerId: "fixture-consumer", executionCredential: "fixture-execution-token",
        cleanupCredential: "fixture-cleanup-token", callbackCredential: "fixture-callback-token" }],
      profiles: [{ ...profile, requestBytes: 4096, outputBytes: 4096, tokens: 100, providerTokenUpperBound: 100 }],
      timeoutMs: 1000, closureWaitMs: 25,
    },
  });
  const input = {
    context: { consumerId: "fixture-consumer" }, saved, requestId: "stored-fixture-request",
    body: Buffer.from('{"model":"fixture-model","stream":true,"store":false,"input":[]}'),
    signal: new AbortController().signal,
    callback: {
      async admit(): Promise<never> { claims++; throw failure("conflict"); },
      async effect(): Promise<never> { throw new Error("unexpected effect"); },
      async rejectBeforeDispatch(): Promise<never> { throw new Error("unexpected rejection"); },
      async closed() { throw new Error("unexpected closure"); },
    },
  };
  const callbacks = authority.createServer();
  const callbackOrigin = await listen(callbacks);
  return {
    authority, input, transport: new NativeHTTPTransport(authority),
    counts: () => ({ posts, closeFences: closeFences.size, claims }),
    prepareFailure: () => { prepareError = failure("unavailable"); },
    recoveryFailure: () => { recoveryError = failure("unknown"); },
    async callback(requestRef: string) {
      const { association } = authority.begin(input, input.body);
      await authority.prepare(association, input.body);
      association.outboundStarted = true;
      return fetch(callbackOrigin + "/private/native/v1/admit", {
        method: "POST",
        headers: { authorization: "Bearer fixture-callback-token", "content-type": "application/json",
          "x-private-detail": "SECRET_SENTINEL" },
        body: JSON.stringify({ consumerId: input.context.consumerId, requestRef,
          worker, admission: saved.admission, descriptor: association.descriptor,
          native: { originRef: "fixture-origin", engineIncarnation: "fixture-engine",
            generation, requestNonce: randomUUID() } }),
      });
    },
    async stop() { await stop(callbacks); await stop(native); },
  };
}

test("native preparation failure retains its closed cause without a native POST", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  const f = await fixture((res) => res.end());
  try {
    f.prepareFailure();
    await assert.rejects(f.transport.request(f.input), { code: "unavailable", message: "SECRET_SENTINEL" });
    assert.deepEqual(records.map((record) => JSON.parse(record)), [{
      event: "gateway_native_transport_failure", phase: "prepare", kernel_code: "unavailable",
      request_ref: f.input.requestId,
    }]);
    assert.deepEqual(f.counts(), { posts: 0, closeFences: 0, claims: 0 });
    assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
  } finally { await f.stop(); }
});

for (const throwingSink of [false, true]) {
  test("native HTTP503 keeps one POST and unavailable semantics (throwing sink=" + throwingSink + ")", async (t) => {
    const records: string[] = [];
    t.mock.method(console, "error", (record: string) => {
      records.push(record);
      if (throwingSink) throw new Error("SECRET_SENTINEL");
    });
    const f = await fixture((res) => res.writeHead(503, { "x-private-detail": "SECRET_SENTINEL" }).end("SECRET_SENTINEL"));
    try {
      await assert.rejects(f.transport.request(f.input), { code: "unavailable", message: "unavailable" });
      assert.deepEqual(records.map((record) => JSON.parse(record)), [{
        event: "gateway_native_transport_failure", phase: "native_response", kernel_code: "denied",
        request_ref: f.input.requestId, http_status: 503,
      }]);
      assert.deepEqual(f.counts(), { posts: 1, closeFences: 1, claims: 0 });
      assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
    } finally { await f.stop(); }
  });
}

test("native receipt recovery failure retains its closed cause and does not replay", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  const f = await fixture((res) => res.writeHead(202, { "content-type": "application/json" }).end("{}"));
  try {
    f.recoveryFailure();
    await assert.rejects(f.transport.request(f.input), { code: "unavailable", message: "unavailable" });
    assert.deepEqual(records.map((record) => JSON.parse(record)), [{
      event: "gateway_native_transport_failure", phase: "receipt_recovery", kernel_code: "unknown",
      request_ref: f.input.requestId, http_status: 202,
    }]);
    assert.deepEqual(f.counts(), { posts: 1, closeFences: 1, claims: 0 });
    assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
  } finally { await f.stop(); }
});

for (const associated of [false, true]) {
  test("callback refusal logs only an authorized saved request ref (associated=" + associated + ")", async (t) => {
    const records: string[] = [];
    t.mock.method(console, "error", (record: string) => records.push(record));
    const f = await fixture((res) => res.end());
    try {
      const response = await f.callback(associated ? f.input.requestId : "SECRET_SENTINEL");
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { code: "denied" });
      assert.deepEqual(records.map((record) => JSON.parse(record)), [{
        event: "gateway_native_callback_failure", phase: associated ? "admit_claim" : "admit_validation",
        kernel_code: associated ? "conflict" : "denied",
        ...(associated ? { request_ref: f.input.requestId } : {}),
      }]);
      assert.deepEqual(f.counts(), { posts: 0, closeFences: 0, claims: associated ? 1 : 0 });
      assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
    } finally { await f.stop(); }
  });
}
