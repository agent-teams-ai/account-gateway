import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createConsumerControlClient,
  GatewayError,
} from "../packages/account-gateway/dist/http/index.js";

void test("execution cleanup SDK accepts only a typed exact positive handoff and never upgrades to mutation", async () => {
  const expected = {
    kind: "execution-cleanup-handoff",
    preparationOperationRef: "prepare-a",
    executionRef: "execution-a",
    admission: {
      invocationRef: "invocation-a",
      attemptRef: "attempt-a",
      accountRef: "account-a",
      authorizationEpoch: 1,
      subjectRef: "subject-a",
      policyRevision: 1,
      bindingRevision: 1,
      profileId: "profile-a",
      limits: { requests: 1, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 1024 },
      expiresAt: "2026-11-22T00:00:00.000Z",
    },
    state: "closed",
    cleanup: "scheduled",
  };
  let body: unknown = expected,
    status = 200;
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method!);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const client = createConsumerControlClient({
    role: "consumer-control",
    origin: `http://127.0.0.1:${address.port}`,
    token: "synthetic-cleanup-sdk-control",
  });
  try {
    for (body of [
      { operationRef: "prepare-a", state: "applied" },
      { ...expected, kind: "close" },
      { ...expected, executionRef: "execution-other" },
      { ...expected, preparationOperationRef: "prepare-other" },
      { ...expected, state: "open" },
      { ...expected, cleanup: "unknown" },
      { ...expected, state: "unknown" },
      { ...expected, admission: { ...expected.admission, issuerEpoch: "private-must-not-leave" } },
    ]) {
      await assert.rejects(
        client.executionCleanupProof("execution-a", "prepare-a"),
        (error: unknown) => error instanceof GatewayError && error.effect === "effect_unknown",
      );
    }
    for (const state of ["closed", "fenced"]) {
      body = { ...expected, state };
      assert.equal((await client.executionCleanupProof("execution-a", "prepare-a")).state, state);
    }
    status = 404;
    body = {};
    await assert.rejects(
      client.executionCleanupProof("execution-a", "prepare-a"),
      (error: unknown) => error instanceof GatewayError && error.effect === "effect_unknown",
    );
    assert.ok(methods.length > 0);
    assert.deepEqual(new Set(methods), new Set(["GET"]));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
