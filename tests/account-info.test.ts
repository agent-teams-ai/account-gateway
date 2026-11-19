import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import * as c from "../packages/account-gateway/dist/contracts/index.js";
import {
  createManagementClient,
  createConsumerControlClient,
  GatewayError,
} from "../packages/account-gateway/dist/http/index.js";

const unknown = { status: "unknown" } as const;
const known = <T>(value: T) => ({
  status: "known" as const,
  value,
  source: "provider_api" as const,
  observedAt: "2026-11-19T10:00:00Z",
  freshness: "current" as const,
});
const info = {
  status: "available" as const,
  infoRevision: "4",
  fields: {
    email: known("owner@example.invalid"),
    accountLabel: unknown,
    subscription: known({
      code: "plus",
      label: "Plus",
      scope: "personal" as const,
      endsAt: { kind: "date" as const, value: "2026-12-06" },
    }),
    credentialExpiresAt: known("2026-11-20T11:00:00Z"),
    privacyMode: known("private" as const),
  },
};
const row = (accountRef: string) => ({
  accountRef,
  metadataRevision: 2,
  authorizationEpoch: 3,
  info,
});

void test("capability v2 supports per-method operations and closed import descriptors", () => {
  const profile = {
    profileId: "gemini-api-fixture",
    provider: { id: "gemini", label: "Gemini" },
    product: { id: "pay_as_you_go", label: "Gemini API" },
    region: { id: "global", label: "Global" },
    protocol: "openai-responses",
    models: [
      {
        modelId: "fixture-model",
        reasoning: null,
        fast: null,
        tools: { allowed: ["function"], default: "function" },
      },
    ],
    methods: [{ kind: "api_key", create: true, reconnect: false }],
    accountInfo: true,
    limitsContract: "none",
    availability: "enabled",
  };
  assert.equal(c.providerConnectionCapabilityV2.safeParse(profile).success, true);
  assert.equal(
    c.providerConnectionCapabilityV2.safeParse({ ...profile, create: true }).success,
    false,
  );
  assert.equal(
    c.providerConnectionCapabilityV2.safeParse({
      ...profile,
      methods: [
        {
          kind: "credential_import",
          method: "oauth_auth_json",
          maxBytes: 65536,
          create: true,
          reconnect: true,
        },
      ],
    }).success,
    true,
  );
  for (const method of ["pat", "agent_identity", "access_token"]) {
    assert.equal(
      c.providerConnectionCapabilityV2.safeParse({
        ...profile,
        methods: [
          { kind: "credential_import", method, maxBytes: 65536, create: true, reconnect: true },
        ],
      }).success,
      false,
    );
  }
  assert.equal(
    c.providerConnectionCapabilitiesV2.safeParse({
      contract: "provider-connections/v2",
      capabilities: [profile, profile],
    }).success,
    false,
  );
});

void test("account info preserves date semantics and rejects secret/extra fields", () => {
  assert.deepEqual(c.accountInfo.parse(info), info);
  assert.equal(
    c.accountInfo.safeParse({ ...info, refreshToken: "secret-sentinel" }).success,
    false,
  );
  assert.equal(
    c.accountInfo.safeParse({
      ...info,
      fields: {
        ...info.fields,
        subscription: {
          ...info.fields.subscription,
          value: {
            ...info.fields.subscription.value,
            endsAt: { kind: "date", value: "2026-02-30" },
          },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    c.accountInfo.safeParse({ status: "unavailable", fields: info.fields }).success,
    false,
  );
  assert.equal(
    c.accountInfo.safeParse({
      ...info,
      fields: { ...info.fields, email: { status: "unknown", value: "previous@example.invalid" } },
    }).success,
    false,
  );
  assert.equal(
    c.accountInfo.safeParse({
      ...info,
      fields: { ...info.fields, accountLabel: known("🦊".repeat(200)) },
    }).success,
    true,
  );
  assert.equal(
    c.accountInfo.safeParse({
      ...info,
      fields: { ...info.fields, accountLabel: known("🦊".repeat(201)) },
    }).success,
    false,
  );
  assert.equal(
    c.accountInfo.safeParse({
      ...info,
      fields: { ...info.fields, email: known("owner\n@example.invalid") },
    }).success,
    false,
  );
});

void test("both account clients read the same bounded metadata contract; identity substitution rejects", async (t) => {
  const refs = Array.from({ length: 50 }, (_, i) => `account-${i}`);
  let requests = 0,
    wrong = false;
  const largeInfo = {
    ...info,
    fields: {
      ...info.fields,
      email: known("界".repeat(320)),
      accountLabel: known("🦊".repeat(200)),
      subscription: known({
        ...info.fields.subscription.value,
        code: "界".repeat(100),
        label: "界".repeat(160),
      }),
    },
  };
  const payload = {
    contract: "account-info/v1",
    accounts: refs.map((ref) => ({ ...row(ref), info: largeInfo })),
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload)) > 65_536,
    "exercises method bound above old default",
  );
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.url, "/v1/account-info/read");
    assert.equal(req.method, "POST");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(wrong ? { ...payload, accounts: payload.accounts.toReversed() } : payload),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const management = createManagementClient({ role: "management", origin, token: "fixture-token" });
  const consumer = createConsumerControlClient({
    role: "consumer-control",
    origin,
    token: "fixture-token",
  });
  const input = { ownerRef: "owner", accountRefs: refs };
  assert.deepEqual(await management.readAccountInfo(input), payload);
  assert.deepEqual(await consumer.readAccountInfo(input), payload);
  wrong = true;
  await assert.rejects(
    management.readAccountInfo(input),
    (error: unknown) => error instanceof GatewayError && error.code === "invalid_response",
  );
  await assert.rejects(
    management.readAccountInfo({ ...input, accountRefs: [refs[0], refs[0]] }),
    (error: unknown) => error instanceof GatewayError && error.code === "invalid_input",
  );
  assert.equal(requests, 3, "no hidden retry and invalid request never enters HTTP");
});
