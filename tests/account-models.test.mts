import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createManagementClient, GatewayError } from "../packages/account-gateway/dist/http/index.js";
import { accountModels, accountModelsRequest } from "../packages/account-gateway/dist/contracts/index.js";

// Detects schema drift, silent fallback from an authoritative empty set, and invalid SDK paths/bodies.
test("account-scoped models use strict canonical wire and management HTTP", async (t) => {
  const input = { ownerRef: "owner", accountRef: "account", profileId: "codex", expectedAuthorizationEpoch: 1, forceRefresh: true };
  const model = { modelId: "future/codex:model-7", reasoning: { allowed: ["max", "ultra"], default: "max" },
    fast: { allowed: ["balanced"], default: "balanced" }, tools: { allowed: ["function"], default: "function" } };
  const snapshot = { status: "snapshot", source: "codex", physicalGeneration: "physical", principalVersion: "principal",
    fetchedAt: "2026-10-25T00:00:00Z", expiresAt: "2026-10-25T00:01:00Z", models: [model] };
  let reply: unknown = snapshot, calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/account-models/read");
    assert.equal(req.headers.authorization, "Bearer fixture");
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
  const sdk = createManagementClient({ role: "management", origin: `http://127.0.0.1:${address.port}`, token: "fixture" });
  assert.deepEqual(await sdk.readAccountModels(input), snapshot);
  for (reply of [{ ...snapshot, models: [] }, { status: "unknown" }, { status: "unsupported" }, { status: "unavailable" }])
    assert.deepEqual(await sdk.readAccountModels(input), reply);
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
    await assert.rejects(sdk.readAccountModels(input), (error) => error instanceof GatewayError && error.code === "invalid_response");
  }
  const before = calls;
  assert.throws(() => sdk.readAccountModels({ ...input, forceRefresh: "yes" } as never), GatewayError);
  assert.equal(calls, before);
  assert.equal(accountModelsRequest.safeParse({ ...input, extra: true }).success, false);
});
