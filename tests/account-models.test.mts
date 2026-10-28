import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createManagementClient, createConsumerControlClient, createExecutionClient, GatewayError } from "../packages/account-gateway/dist/http/index.js";
import { accountModelCapability, accountModelDiscoveryProfile, accountModelDiscoverySource, accountModels, accountModelsRequest } from "../packages/account-gateway/dist/contracts/index.js";

// Detects schema drift, silent fallback from an authoritative empty set, and invalid SDK paths/bodies.
void test("account-scoped models use strict canonical wire through management and consumer-control HTTP", async (t) => {
  const input = {
    ownerRef: "owner",
    accountRef: "account",
    profileId: "codex",
    expectedAuthorizationEpoch: 1,
    forceRefresh: true,
  };
  const model = {
    modelId: "future/codex:model-7",
    reasoning: { allowed: ["max", "ultra"], default: "max" },
    fast: { allowed: ["balanced"], default: "balanced" },
    tools: { allowed: ["function"], default: "function" },
  };
  const snapshot = {
    status: "snapshot",
    source: "codex",
    physicalGeneration: "physical",
    principalVersion: "principal",
    fetchedAt: "2026-10-25T00:00:00Z",
    expiresAt: "2026-10-25T00:01:00Z",
    models: [model],
  };
  let reply: unknown = snapshot,
    calls = 0;
  const authorizations: string[] = [];
  const settlements: Promise<void>[] = [];
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    const settlement = (async () => {
      calls++;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/account-models/read");
      assert.ok(["Bearer fixture", "Bearer consumer-fixture"].includes(req.headers.authorization!));
      authorizations.push(req.headers.authorization!);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), input);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    })().catch((error: unknown) => {
      failures.push(error);
      res.destroy();
    });
    settlements.push(settlement);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await Promise.all(settlements);
    assert.deepEqual(failures, [], "account models fixture handler failed");
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const sdk = createManagementClient({ role: "management", origin, token: "fixture" });
  const consumer = createConsumerControlClient({
    role: "consumer-control",
    origin,
    token: "consumer-fixture",
  });
  assert.deepEqual(await sdk.readAccountModels(input), snapshot);
  assert.deepEqual(await consumer.readAccountModels(input), snapshot);
  assert.deepEqual(authorizations, ["Bearer fixture", "Bearer consumer-fixture"]);
  assert.equal("request" in consumer, false);
  assert.equal("prepare" in consumer, false);
  const execution = createExecutionClient({
    role: "execution",
    origin,
    token: "execution-fixture",
  });
  assert.equal("readAccountModels" in execution, false);
  assert.throws(
    () => createConsumerControlClient({ role: "execution", origin, token: "fixture" } as never),
    GatewayError,
  );
  for (reply of [
    { ...snapshot, models: [] },
    { status: "unknown" },
    { status: "unsupported" },
    { status: "unavailable" },
  ]) {
    for (const client of [sdk, consumer]) {
      assert.deepEqual(await client.readAccountModels(input), reply);
    }
  }
  for (reply of [
    { ...snapshot, models: [model, model] },
    { ...snapshot, models: [{ ...model, modelId: "bad model" }] },
    { ...snapshot, models: [{ ...model, reasoning: { allowed: ["medium"], default: "max" } }] },
    { ...snapshot, models: [{ ...model, fast: { allowed: ["fast"], default: "fast" } }] },
    {
      ...snapshot,
      models: [
        { ...model, tools: { allowed: ["function_and_custom"], default: "function_and_custom" } },
      ],
    },
    { ...snapshot, models: [{ ...model, label: "Untrusted" }] },
    { ...snapshot, expiresAt: snapshot.fetchedAt },
    { ...snapshot, access_token: "forbidden" },
  ]) {
    assert.equal(accountModels.safeParse(reply).success, false);
    for (const client of [sdk, consumer]) {
      await assert.rejects(
        client.readAccountModels(input),
        (error) => error instanceof GatewayError && error.code === "invalid_response",
      );
    }
  }
  const before = calls;
  for (const client of [sdk, consumer]) {
    assert.throws(
      () => client.readAccountModels({ ...input, forceRefresh: "yes" } as never),
      GatewayError,
    );
    assert.throws(
      () => client.readAccountModels({ ...input, expectedAuthorizationEpoch: -1 }),
      GatewayError,
    );
  }
  assert.equal(calls, before);
  assert.equal(accountModelsRequest.safeParse({ ...input, extra: true }).success, false);
});

// Triggers and admission guards share one profile identity authority.
void test("model discovery recognizes only qualified protocol/auth identities", () => {
  const profile = accountModelDiscoveryProfile("openrouter-openai-responses-apikey-v1");
  assert.ok(profile);
  assert.equal(accountModelDiscoverySource(profile), "openrouter");
  assert.equal(accountModelDiscoverySource({ ...profile, authKind: "oauth" }), undefined);
  assert.equal(accountModelDiscoverySource({ ...profile, protocol: "openai-chat" }), undefined);
  assert.equal(accountModelDiscoverySource({ ...profile, profileId: "openrouter-imitation" }), undefined);
  assert.equal(accountModelDiscoveryProfile("unqualified"), undefined);
  assert.ok(Object.isFrozen(profile));
  const codex = accountModelDiscoveryProfile("openai-codex-oauth-responses-v1");
  assert.ok(codex);
  assert.equal(accountModelDiscoverySource(codex), "codex");
});

void test("OpenRouter discovery supports bounded full catalogs without weakening Codex controls", () => {
  const model = { modelId: "future-vendor/review:model", reasoning: null, fast: null,
    tools: { allowed: ["none", "function"], default: "function" } };
  const snapshot = { status: "snapshot", source: "openrouter", physicalGeneration: "physical", principalVersion: "principal",
    fetchedAt: "2026-10-25T00:00:00Z", expiresAt: "2026-10-25T00:01:00Z", models: [model] };
  assert.equal(accountModelCapability.safeParse(model).success, true);
  const rows = Array.from({ length: 2048 }, (_, i) => ({ ...model, modelId: `future-vendor/model-${i}` }));
  assert.equal(accountModels.safeParse({ ...snapshot, models: rows }).success, true);
  assert.equal(accountModels.safeParse({ ...snapshot, models: [...rows, { ...model, modelId: "overflow" }] }).success, false);
  assert.equal(accountModels.safeParse({ ...snapshot, models: [model, model] }).success, false);
  assert.equal(accountModels.safeParse({ ...snapshot, source: "unqualified" }).success, false);
  assert.equal(accountModels.safeParse({ ...snapshot, models: [{ ...model, fast: { allowed: ["fast"], default: "fast" } }] }).success, false);
  assert.equal(accountModels.safeParse({ ...snapshot, models: [{ ...model, tools: { allowed: ["function_and_custom"], default: "function_and_custom" } }] }).success, false);
  const codex = { ...model, fast: { allowed: ["balanced"], default: "balanced" }, tools: { allowed: ["function"], default: "function" } };
  assert.equal(accountModelCapability.safeParse(codex).success, true);
  assert.equal(accountModels.safeParse({ ...snapshot, source: "codex", models: [codex] }).success, true);
  assert.equal(accountModels.safeParse({ ...snapshot, source: "codex", models: rows.slice(0,129).map((row) => ({ ...codex, modelId: row.modelId })) }).success, false);
  assert.equal(accountModels.safeParse({ ...snapshot, source: "codex", models: [model] }).success, false);
});

void test("SDK transports the complete OpenRouter snapshot under an explicit 2MiB bound", async (t) => {
  const input = { ownerRef: "owner", accountRef: "account", profileId: "openrouter-openai-responses-apikey-v1", expectedAuthorizationEpoch: 1 };
  const snapshot = { status: "snapshot", source: "openrouter", physicalGeneration: "physical", principalVersion: "principal",
    fetchedAt: "2026-10-25T00:00:00Z", expiresAt: "2026-10-25T00:01:00Z",
    models: Array.from({ length: 2048 }, (_, i) => ({ modelId: `future-vendor/model-${i}`, reasoning: null, fast: null,
      tools: { allowed: ["none", "function"], default: "function" } })) };
  const bytes = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(bytes) > 65536);
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/account-models/read");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), input);
    res.setHeader("content-type", "application/json"); res.end(bytes);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const client of [
    createManagementClient({ role: "management", origin, token: "fixture", responseBytes: 2 * 1024 * 1024 }),
    createConsumerControlClient({ role: "consumer-control", origin, token: "fixture", responseBytes: 2 * 1024 * 1024 }),
  ]) assert.deepEqual(await client.readAccountModels(input), snapshot);
  await assert.rejects(createManagementClient({ role: "management", origin, token: "fixture" }).readAccountModels(input),
    (error) => error instanceof GatewayError && error.code === "invalid_response");
});
