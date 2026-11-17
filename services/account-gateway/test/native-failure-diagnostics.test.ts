// Real ephemeral TCP transport/callback paths; no SQL, native binary or provider.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { KernelError } from "../src/domain.ts";
import type { SavedExecution } from "../src/domain.ts";
import { NativeAuthority } from "../src/native-authority.ts";
import type { AuthorityOptions } from "../src/native-authority.ts";
import { NativeHTTPTransport } from "../src/native-transport.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
function failure(code: KernelError["code"]) {
  const error = new KernelError(code);
  error.message = "SECRET_SENTINEL";
  return error;
}
async function fixture(reply: (res: ServerResponse, req: IncomingMessage) => void) {
  let posts = 0,
    claims = 0;
  const closeFences = new Set<string>();
  let prepareError: KernelError | undefined, recoveryError: KernelError | undefined;
  let dispatchProof: unknown;
  const native = createServer((req, res) => {
    void (async () => {
      for await (const _ of req) {
        /* Drain fixture input. */
      }
      posts++;
      reply(res, req);
    })();
  });
  const origin = await listen(native);
  const generation = randomUUID(),
    worker = randomUUID();
  const profile = {
    profile: "loopback-profile",
    baseURL: "https://fixture.invalid/v1",
    model: "fixture-model",
    qualificationRef: "loopback-only",
  };
  const saved: SavedExecution = {
    generation,
    state: "open",
    dispatchAllowed: true,
    admission: {
      executionRef: randomUUID(),
      issuerEpoch: randomUUID(),
      accountRef: randomUUID(),
      invocationRef: "fixture-invocation",
      attemptRef: "fixture-attempt",
      subjectRef: "fixture-subject",
      authorizationEpoch: 1,
      policyRevision: 1,
      bindingRevision: 1,
      profileId: profile.profile,
      limits: { requests: 1, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const kernel = {
    async savedExecution() {
      if (prepareError) {
        throw prepareError;
      }
      return saved;
    },
    async currentWorkerLease() {
      return saved.admission.expiresAt;
    },
    async requestProof() {
      if (recoveryError) {
        throw recoveryError;
      }
      return dispatchProof;
    },
    async request() {
      return { effect: "response_started" };
    },
    async close(_context: unknown, closeRef: string) {
      closeFences.add(closeRef);
    },
  };
  const authority = new NativeAuthority({
    kernel: kernel as unknown as AuthorityOptions["kernel"],
    executionBearers: {
      async resolveExecution(): Promise<never> {
        throw failure("unavailable");
      },
      current() {
        return true;
      },
    },
    store: {
      async mapping() {
        return {
          consumerId: "fixture-consumer",
          operationId: "fixture-operation",
          ownerRef: "fixture-owner",
          accountRef: saved.admission.accountRef,
          purpose: "create",
          generation,
          worker,
          profile,
          descriptor: {
            generation,
            nativePhysicalIdentity: generation,
            nativeId: 1,
            createdAt: "2026-10-03T04:05:06Z",
            profile: profile.profile,
            baseURL: profile.baseURL,
            model: profile.model,
          },
        };
      },
    },
    config: {
      origin,
      enrollment: {
        originRef: "fixture-origin",
        engineIncarnation: "fixture-engine",
        worker,
        qualificationRef: profile.qualificationRef,
      },
      consumers: [
        {
          consumerId: "fixture-consumer",
          executionCredential: "fixture-execution-token",
          cleanupCredential: "fixture-cleanup-token",
          callbackCredential: "fixture-callback-token",
        },
      ],
      profiles: [
        {
          ...profile,
          requestBytes: 4096,
          outputBytes: 4096,
          tokens: 100,
          providerTokenUpperBound: 100,
        },
      ],
      timeoutMs: 1000,
      closureWaitMs: 25,
    },
  });
  const input = {
    context: { consumerId: "fixture-consumer" },
    saved,
    requestId: "stored-fixture-request",
    body: Buffer.from('{"model":"fixture-model","stream":true,"store":false,"input":[]}'),
    signal: new AbortController().signal,
    callback: {
      async admit(): Promise<never> {
        claims++;
        throw failure("conflict");
      },
      async effect(): Promise<never> {
        throw new Error("unexpected effect");
      },
      async rejectBeforeDispatch(): Promise<never> {
        throw new Error("unexpected rejection");
      },
      async closed() {
        throw new Error("unexpected closure");
      },
    },
  };
  const callbacks = authority.createServer();
  const callbackOrigin = await listen(callbacks);
  return {
    authority,
    input,
    transport: new NativeHTTPTransport(authority),
    counts: () => ({ posts, closeFences: closeFences.size, claims }),
    prepareFailure: () => {
      prepareError = failure("unavailable");
    },
    recoveryFailure: () => {
      recoveryError = failure("unknown");
    },
    proof: () => dispatchProof,
    // A recorded dispatch proof, so a 200 stream reaches the body and settlement.
    dispatched: () => {
      dispatchProof = {
        executionRef: saved.admission.executionRef,
        requestRef: input.requestId,
        worker,
        token: "fixture-proof",
        native: {
          originRef: "fixture-origin",
          engineIncarnation: "fixture-engine",
          requestNonce: randomUUID(),
          generation,
        },
      };
    },
    async unauthenticatedCallback() {
      return fetch(callbackOrigin + "/private/native/v1/admit", {
        method: "POST",
        headers: {
          authorization: "Bearer unauthorized-fixture-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestRef: "SECRET_SENTINEL" }),
      });
    },
    async executionAuthorityFailure() {
      return fetch(callbackOrigin + "/private/native/v1/execution-authority", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-callback-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionBearer: "fixture-execution-token",
          requestRef: "SECRET_SENTINEL",
        }),
      });
    },
    async callback(requestRef: string) {
      const { association } = authority.begin(input, input.body);
      await authority.prepare(association, input.body);
      association.outboundStarted = true;
      return fetch(callbackOrigin + "/private/native/v1/admit", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-callback-token",
          "content-type": "application/json",
          "x-private-detail": "SECRET_SENTINEL",
        },
        body: JSON.stringify({
          consumerId: input.context.consumerId,
          requestRef,
          worker,
          admission: saved.admission,
          descriptor: association.descriptor,
          native: {
            originRef: "fixture-origin",
            engineIncarnation: "fixture-engine",
            generation,
            requestNonce: randomUUID(),
          },
        }),
      });
    },
    async stop() {
      await stop(callbacks);
      await stop(native);
    },
  };
}

void test("native preparation failure retains its closed cause without a native POST", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  const f = await fixture((res) => res.end());
  try {
    f.prepareFailure();
    await assert.rejects(f.transport.request(f.input), {
      code: "unavailable",
      message: "SECRET_SENTINEL",
    });
    assert.deepEqual(
      records.map((record) => JSON.parse(record) as unknown),
      [
        {
          event: "gateway_native_transport_failure",
          phase: "prepare",
          kernel_code: "unavailable",
          request_ref: f.input.requestId,
        },
      ],
    );
    assert.deepEqual(f.counts(), { posts: 0, closeFences: 0, claims: 0 });
    assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
  } finally {
    await f.stop();
  }
});

for (const throwingSink of [false, true]) {
  void test(
    "native HTTP503 keeps one POST and unavailable semantics (throwing sink=" + throwingSink + ")",
    async (t) => {
      const records: string[] = [];
      t.mock.method(console, "error", (record: string) => {
        records.push(record);
        if (throwingSink) {
          throw new Error("SECRET_SENTINEL");
        }
      });
      const f = await fixture((res) =>
        res.writeHead(503, { "x-private-detail": "SECRET_SENTINEL" }).end("SECRET_SENTINEL"),
      );
      try {
        await assert.rejects(f.transport.request(f.input), {
          code: "unavailable",
          message: "unavailable",
        });
        assert.deepEqual(
          records.map((record) => JSON.parse(record) as unknown),
          [
            {
              event: "gateway_native_transport_failure",
              phase: "native_response",
              kernel_code: "denied",
              request_ref: f.input.requestId,
              http_status: 503,
            },
          ],
        );
        assert.deepEqual(f.counts(), { posts: 1, closeFences: 1, claims: 0 });
        assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
      } finally {
        await f.stop();
      }
    },
  );
}

void test("native receipt recovery failure retains its closed cause and does not replay", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  const f = await fixture((res) =>
    res.writeHead(202, { "content-type": "application/json" }).end("{}"),
  );
  try {
    f.recoveryFailure();
    await assert.rejects(f.transport.request(f.input), {
      code: "unavailable",
      message: "unavailable",
    });
    assert.deepEqual(
      records.map((record) => JSON.parse(record) as unknown),
      [
        {
          event: "gateway_native_transport_failure",
          phase: "receipt_recovery",
          kernel_code: "unknown",
          request_ref: f.input.requestId,
          http_status: 202,
        },
      ],
    );
    assert.deepEqual(f.counts(), { posts: 1, closeFences: 1, claims: 0 });
    assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
  } finally {
    await f.stop();
  }
});

for (const associated of [false, true]) {
  void test(
    "callback refusal logs only an authorized saved request ref (associated=" + associated + ")",
    async (t) => {
      const records: string[] = [];
      t.mock.method(console, "error", (record: string) => records.push(record));
      const f = await fixture((res) => res.end());
      try {
        const response = await f.callback(associated ? f.input.requestId : "SECRET_SENTINEL");
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { code: "denied" });
        assert.deepEqual(
          records.map((record) => JSON.parse(record) as unknown),
          [
            {
              event: "gateway_native_callback_failure",
              phase: associated ? "admit_claim" : "admit_validation",
              kernel_code: associated ? "conflict" : "denied",
              ...(associated ? { request_ref: f.input.requestId } : {}),
            },
          ],
        );
        assert.deepEqual(f.counts(), { posts: 0, closeFences: 0, claims: associated ? 1 : 0 });
        assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
      } finally {
        await f.stop();
      }
    },
  );
}

void test("callback pre-work authentication refusal survives a throwing diagnostic sink", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => {
    records.push(record);
    throw new Error("SECRET_SENTINEL");
  });
  const f = await fixture((res) => res.end());
  try {
    const response = await f.unauthenticatedCallback();
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: "denied" });
    assert.deepEqual(
      records.map((record) => JSON.parse(record) as unknown),
      [
        {
          event: "gateway_native_callback_failure",
          phase: "callback_authentication",
          kernel_code: "denied",
        },
      ],
    );
    assert.deepEqual(f.counts(), { posts: 0, closeFences: 0, claims: 0 });
    assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
  } finally {
    await f.stop();
  }
});

void test("public execution authority preserves its HTTP503 refusal without logging an untrusted ref", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  const f = await fixture((res) => res.end());
  try {
    const response = await f.executionAuthorityFailure();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "unavailable" });
    assert.deepEqual(
      records.map((record) => JSON.parse(record) as unknown),
      [
        {
          event: "gateway_native_callback_failure",
          phase: "callback_execution_authority",
          kernel_code: "unavailable",
        },
      ],
    );
    assert.deepEqual(f.counts(), { posts: 0, closeFences: 0, claims: 0 });
    assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
  } finally {
    await f.stop();
  }
});

const transportPath = "/private/native/v1/transports";
function stream(res: ServerResponse, requestRef: string) {
  return res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-gateway-request-ref": requestRef,
    "x-private-detail": "SECRET_SENTINEL",
  });
}
// A valid owner receipt whose native lifetime never reaches physical closure.
function openReceipt(res: ServerResponse, proof: unknown) {
  const p = proof as { executionRef: string; requestRef: string; native: unknown };
  res.writeHead(202, { "content-type": "application/json" }).end(
    JSON.stringify({
      consumerId: "fixture-consumer",
      executionRef: p.executionRef,
      requestRef: p.requestRef,
      native: p.native,
      proof,
      phase: "entered",
      effect: "effect_unknown",
      sealed: false,
      acknowledged: false,
      lifetime: {
        entered: true,
        contextDone: false,
        forwardingReturned: false,
        bodyKnown: false,
        bodyClosed: false,
        closeFailed: false,
        completed: false,
        sealed: false,
      },
    }),
  );
}
for (const [name, phase, reply] of [
  [
    "output over the admitted bytes",
    "stream_output_limit",
    (res: ServerResponse, req: IncomingMessage, ref: string) => {
      if (req.url === transportPath) {
        stream(res, ref).end("x".repeat(5000));
      } else {
        res.writeHead(409).end();
      }
    },
  ],
  [
    "a body cut before its end",
    "stream_read",
    (res: ServerResponse, req: IncomingMessage, ref: string) => {
      if (req.url === transportPath) {
        stream(res, ref).write("data: SECRET_SENTINEL\n\n", () => res.socket?.destroy());
      } else {
        res.writeHead(409).end();
      }
    },
  ],
  [
    "a settlement whose closure never arrives",
    "settle_closure_wait",
    (res: ServerResponse, req: IncomingMessage, ref: string, proof: unknown) => {
      if (req.url === transportPath) {
        stream(res, ref).end("data: SECRET_SENTINEL\n\n");
      } else {
        openReceipt(res, proof);
      }
    },
  ],
] as const) {
  void test("a stopped stream names its phase: " + name, async (t) => {
    const records: string[] = [];
    t.mock.method(console, "error", (record: string) => records.push(record));
    let requestRef = "";
    let proof: unknown;
    const f = await fixture((res, req) => {
      reply(res, req, requestRef, proof);
    });
    try {
      requestRef = f.input.requestId;
      f.dispatched();
      proof = f.proof();
      const result = await f.transport.request(f.input);
      assert.equal(result.kind, "stream");
      await assert.rejects(
        (async () => {
          for await (const _ of result.body) {
            /* Drain like the facade. */
          }
        })(),
        { code: "unavailable", message: "unavailable" },
      );
      const rows = records.map((record) => JSON.parse(record) as Record<string, unknown>);
      assert.deepEqual(
        rows.filter((row) => row.event === "gateway_native_transport_failure"),
        [
          {
            event: "gateway_native_transport_failure",
            phase,
            ...(phase === "stream_read" ? {} : { kernel_code: "denied" }),
            request_ref: f.input.requestId,
          },
        ],
      );
      assert.equal(records.join("").includes("SECRET_SENTINEL"), false);
    } finally {
      await f.stop();
    }
  });
}

void test("a caller that cancels its stream is not logged as a transport failure", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  let requestRef = "";
  const f = await fixture((res, req) => {
    if (req.url === transportPath) {
      stream(res, requestRef).end("data: SECRET_SENTINEL\n\n");
    } else {
      res.writeHead(409).end();
    }
  });
  try {
    requestRef = f.input.requestId;
    f.dispatched();
    const caller = new AbortController();
    const result = await f.transport.request({ ...f.input, signal: caller.signal });
    assert.equal(result.kind, "stream");
    caller.abort();
    await assert.rejects(
      (async () => {
        for await (const _ of result.body) {
          /* Drain like the facade. */
        }
      })(),
      { code: "unavailable" },
    );
    assert.deepEqual(
      records.filter((record) => record.includes("gateway_native_transport_failure")),
      [],
    );
  } finally {
    await f.stop();
  }
});
