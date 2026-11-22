import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createConsumerControlClient,
  GatewayError,
} from "../packages/account-gateway/dist/http/index.js";

void test("typed close SDK refuses generic or misbound ACKs and retains non-applied observations", async () => {
  const expected = {
    kind: "close",
    operationRef: "close-a",
    executionRef: "execution-a",
    state: "applied",
  };
  let body: unknown = expected;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
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
    token: "synthetic-close-proof-control",
  });
  try {
    for (body of [
      { operationRef: "close-a", state: "applied" },
      { ...expected, kind: "fence" },
      { ...expected, executionRef: "another-execution" },
      { ...expected, operationRef: "another-operation" },
    ]) {
      await assert.rejects(
        client.closeOperation("execution-a", "close-a"),
        (error: unknown) => error instanceof GatewayError && error.effect === "effect_unknown",
      );
    }
    for (const state of ["pending", "unknown", "rejected", "applied"] as const) {
      body = { ...expected, state };
      assert.equal((await client.closeOperation("execution-a", "close-a")).state, state);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
