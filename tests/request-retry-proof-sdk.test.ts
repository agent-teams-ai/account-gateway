import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const sdk = await import("../packages/account-gateway/dist/http/index.js");
const contracts = await import("../packages/account-gateway/dist/contracts/index.js");

void test("request retry proof SDK: one bounded exact read, finite proof and no fallback or replay", async (t) => {
  const expected = {
    kind: "request-retry-proof/v1",
    consumerId: "sdk-consumer",
    executionRef: "execution-original",
    requestRef: "request-original",
    nonEntryReason: "admission_storage_conflict",
    transportClosed: true,
  };
  let response: unknown = expected, status = 200, calls = 0;
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    try {
      calls++;
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/executions/execution-original/requests/request-original/retry-proof");
      assert.equal(req.headers.authorization, "Bearer synthetic-sdk-execution");
      assert.equal(req.headers["x-account-gateway-capability"], "request-retry-proof/v1");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      failures.push(error);
      res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(failures, []);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = sdk.createExecutionClient({
    role: "execution", origin: "http://127.0.0.1:" + address.port,
    token: "synthetic-sdk-execution", timeoutMs: 1000,
  });
  assert.deepEqual(await client.retryProof(expected.executionRef, expected.requestRef), expected);
  assert.equal(calls, 1);
  const invalid = [
    { ...expected, kind: "request-retry-proof/v2" },
    { ...expected, nonEntryReason: "native_rejected" },
    { ...expected, transportClosed: false },
    { ...expected, executionRef: "foreign-execution" },
    { ...expected, requestRef: "foreign-request" },
    { ...expected, token: "forbidden-closure-token" },
    { requestRef: expected.requestRef, effect: "rejected_before_dispatch", status: "failed" },
  ];
  for (const value of invalid) {
    response = value;
    const before = calls;
    await assert.rejects(
      client.retryProof(expected.executionRef, expected.requestRef),
      (error: unknown) => error instanceof sdk.GatewayError && error.code === "invalid_response",
    );
    assert.equal(calls, before + 1);
  }
  status = 404;
  response = {
    code: "not_found", traceRef: "synthetic-trace", requestRef: expected.requestRef,
    effect: "not_dispatched", retry: { kind: "never" },
  };
  const before = calls;
  await assert.rejects(
    client.retryProof(expected.executionRef, expected.requestRef),
    (error: unknown) => error instanceof sdk.GatewayError &&
      error.code === "safe_error" && error.effect === "effect_unknown",
  );
  assert.equal(calls, before + 1);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    client.retryProof(expected.executionRef, expected.requestRef, { signal: aborted.signal }),
    (error: unknown) => error instanceof sdk.GatewayError && error.code === "cancelled",
  );
  assert.equal(calls, before + 1);
});

void test("request retry proof does not extend legacy status or allow retrying the original request", () => {
  const status = {
    requestRef: "request-original", effect: "rejected_before_dispatch", status: "failed",
    error: {
      code: "upstream_failure", traceRef: "synthetic-trace", requestRef: "request-original",
      effect: "rejected_before_dispatch", retry: { kind: "never" },
    },
  };
  assert.equal(contracts.requestStatus.safeParse(status).success, true);
  assert.equal(contracts.requestStatus.safeParse({
    ...status, nonEntryReason: "admission_storage_conflict",
  }).success, false);
  assert.equal(contracts.requestStatus.safeParse({
    ...status, error: { ...status.error, retry: { kind: "after", milliseconds: 0 } },
  }).success, false);
});
