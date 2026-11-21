import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const c = await import(process.env.GATEWAY_CONTRACTS ?? "../packages/account-gateway/dist/contracts/index.js");
const sdk = await import(process.env.GATEWAY_HTTP ?? "../packages/account-gateway/dist/http/index.js");
const method = {
  methodId: "fixture_native_key", revision: 1, configurationGeneration: "target-generation-a",
  label: "Native credential", create: true, reconnect: true,
  allowedCredentialPolicies: ["provider_key"], requirements: [...c.CONNECTION_REQUIRED_CAPABILITIES],
  availability: "enabled",
  interaction: { kind: "credential_form", inputFields: [
    { fieldId: "credential", kind: "secret", label: "Credential", required: true, maxBytes: 64 },
  ] },
};
const profile = {
  profileId: "new-native-profile", provider: { id: "new_provider", label: "New provider" },
  product: { id: "new_product", label: "New product" }, region: { id: "local", label: "Local" },
  protocol: "openai-responses", models: [{ modelId: "fixture-model", reasoning: null, fast: null,
    tools: { default: "function", allowed: ["function"] } }],
  modelPolicy: { contract: "native-account-models/v2", sourceId: "new_source", unavailableFallback: "deny" },
  methods: [method], accountInfo: true, limitsContract: "account-limits/v3", availability: "enabled",
};
const binding = { profileId: profile.profileId, methodId: method.methodId, methodRevision: 1,
  configurationGeneration: method.configurationGeneration };

test("new native IDs stay usable alongside unsupported requirements and field primitives", () => {
  const catalog = c.providerConnectionCapabilitiesV3.parse({ contract: c.PROVIDER_CONNECTIONS_V3_CONTRACT,
    capabilities: [{ ...profile, methods: [method,
      { ...method, methodId: "future_requirement", requirements: ["future_credential_custody/v1"] },
      { ...method, methodId: "future_field", interaction: { kind: "credential_form", inputFields: [
        { ...method.interaction.inputFields[0], kind: "future_hardware_key", hardware: { mode: "native" } },
      ] } },
    ] }] });
  assert.deepEqual(catalog.capabilities[0].methods.map(c.supportsConnectionMethod), [true, false, false]);
  assert.equal(c.providerConnectionCapabilitiesV3.safeParse({ contract: c.PROVIDER_CONNECTIONS_V3_CONTRACT,
    capabilities: [{ ...profile, methods: [{ ...method, interaction: { kind: "credential_form", inputFields: [
      { ...method.interaction.inputFields[0], maxBytes: -1 },
    ] } }] }] }).success, false);
});

test("opaque credential ingress checks envelope bounds without interpreting native syntax", () => {
  const fields = method.interaction.inputFields;
  assert.equal(sdk.secretSubmission.validateConnectionFields(fields, { credential: "opaque://native-format" }), true);
  assert.equal(sdk.secretSubmission.validateConnectionFields(fields, { credential: "x", endpoint: "https://attacker.invalid" }), false);
  assert.equal(sdk.secretSubmission.validateConnectionFields(fields, { credential: "x".repeat(65) }), false);
  assert.equal(sdk.secretSubmission.connectionInputFields.safeParse({ credential: "\ud800" }).success, false);
});

test("lost sensitive ACK makes one HTTP attempt and retains only operation identity in the error", async (t) => {
  let calls = 0;
  let captured;
  const server = createServer(async (req, res) => {
    calls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, "/v3/accounts/connections/begin");
    res.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = sdk.createManagementClient({ role: "management", token: "fixture-control",
    origin: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  const input = { operationId: "new-connection", ownerRef: "owner", displayName: "Fixture", connection: binding,
    inputFields: { credential: "write-only-fixture-secret" } };
  await assert.rejects(client.beginConnection(input), (error) => {
    assert.equal(error.operationRef, input.operationId);
    assert.equal(error.effect, "effect_unknown");
    assert.equal(JSON.stringify(error).includes(input.inputFields.credential), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(captured, input);
});

test("generic observations keep old strict readers and unknown billing truthful", () => {
  const snapshot = { status: "snapshot", physicalGeneration: "generation", principalVersion: "principal", revision: 1,
    scope: "account", windows: [{ id: "primary", provider: "new_provider", dimension: "plan_quota", unit: "credits",
      period: { kind: "unknown" }, label: null, usedPercent: null, observedAt: null, resetAt: null }] };
  assert.equal(c.accountLimitsV3.safeParse(snapshot).success, true);
  assert.equal(c.accountLimitsV2.safeParse(snapshot).success, false);
  assert.equal(c.accountLimitsV3.safeParse({ ...snapshot, windows: [{ ...snapshot.windows[0], label: "5h" }] }).success, false);
  const old = { schemaVersion: 1, eventId: "event", revision: 0, executionRef: "execution", requestRef: "request",
    invocationRef: "invocation", attemptRef: "attempt", accountRef: "account", profileId: profile.profileId,
    model: "fixture-model", occurredAt: "2026-11-21T10:00:00Z", effect: "effect_unknown", completeness: "unknown",
    inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, cost: null };
  const projected = c.projectUsageV2(old);
  assert.equal(projected.nativeContext, null);
  assert.equal(projected.cost, null);
  assert.deepEqual(c.projectUsageV1(projected), old);
  assert.equal(c.usageObservationV2.safeParse({ ...projected, nativeContext: { providerId: "new_provider", productId: "new_product",
    profileId: profile.profileId, modelId: "wrong-model", billing: { status: "unknown" } } }).success, false);
});
