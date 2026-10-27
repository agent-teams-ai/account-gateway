import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createManagementClient, createConsumerControlClient, createExecutionClient, GatewayError } from "../packages/account-gateway/dist/http/index.js";
import { accountModels, accountModelsRequest } from "../packages/account-gateway/dist/contracts/index.js";

// Detects schema drift, silent fallback from an authoritative empty set, and invalid SDK paths/bodies.
test("account-scoped models use strict canonical wire through management and consumer-control HTTP", async (t) => {
  const input = { ownerRef: "owner", accountRef: "account", profileId: "codex", expectedAuthorizationEpoch: 1, forceRefresh: true };
  const model = { modelId: "future/codex:model-7", reasoning: { allowed: ["max", "ultra"], default: "max" },
    fast: { allowed: ["balanced"], default: "balanced" }, tools: { allowed: ["function"], default: "function" } };
  const snapshot = { status: "snapshot", source: "codex", physicalGeneration: "physical", principalVersion: "principal",
    fetchedAt: "2026-10-25T00:00:00Z", expiresAt: "2026-10-25T00:01:00Z", models: [model] };
  let reply: unknown = snapshot, calls = 0;
  const authorizations: string[] = [];
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/account-models/read");
    assert.ok(["Bearer fixture", "Bearer consumer-fixture"].includes(req.headers.authorization!));
    authorizations.push(req.headers.authorization!);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), input);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const sdk = createManagementClient({ role: "management", origin, token: "fixture" });
  const consumer = createConsumerControlClient({ role: "consumer-control", origin, token: "consumer-fixture" });
  assert.deepEqual(await sdk.readAccountModels(input), snapshot);
  assert.deepEqual(await consumer.readAccountModels(input), snapshot);
  assert.deepEqual(authorizations, ["Bearer fixture", "Bearer consumer-fixture"]);
  assert.equal("request" in consumer, false);
  assert.equal("prepare" in consumer, false);
  const execution = createExecutionClient({ role: "execution", origin, token: "execution-fixture" });
  assert.equal("readAccountModels" in execution, false);
  assert.throws(() => createConsumerControlClient({ role: "execution", origin, token: "fixture" } as never), GatewayError);
  for (reply of [{ ...snapshot, models: [] }, { status: "unknown" }, { status: "unsupported" }, { status: "unavailable" }])
    for (const client of [sdk, consumer]) assert.deepEqual(await client.readAccountModels(input), reply);
  for (reply of [
    { ...snapshot, models: [model, model] },
    { ...snapshot, models: [{ ...model, modelId: "bad model" }] },
    { ...snapshot, models: [{ ...model, reasoning: { allowed: ["medium"], default: "max" } }] },
    { ...snapshot, models: [{ ...model, fast: { allowed: ["fast"], default: "fast" } }] },
    { ...snapshot, models: [{ ...model, tools: { allowed: ["function_and_custom"], default: "function_and_custom" } }] },
    { ...snapshot, models: [{ ...model, label: "Untrusted" }] },
    { ...snapshot, expiresAt: snapshot.fetchedAt },
    { ...snapshot, access_token: "forbidden" },
  ]) {
    assert.equal(accountModels.safeParse(reply).success, false);
    for (const client of [sdk, consumer])
      await assert.rejects(client.readAccountModels(input), (error) => error instanceof GatewayError && error.code === "invalid_response");
  }
  const before = calls;
  for (const client of [sdk, consumer]) {
    assert.throws(() => client.readAccountModels({ ...input, forceRefresh: "yes" } as never), GatewayError);
    assert.throws(() => client.readAccountModels({ ...input, expectedAuthorizationEpoch: -1 }), GatewayError);
  }
  assert.equal(calls, before);
  assert.equal(accountModelsRequest.safeParse({ ...input, extra: true }).success, false);
});
