import test from "node:test";
import type { TestContext } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
const sdk = await import("../packages/account-gateway/dist/http/index.js");
const c = await import("../packages/account-gateway/dist/contracts/index.js");

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    const bytes: unknown = chunk;
    assert.ok(bytes instanceof Uint8Array);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString();
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function fixture(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const settlements: Promise<void>[] = [];
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    try {
      const completion = handler.call(server, req, res);
      if (completion !== undefined) {
        settlements.push(
          completion.catch((error: unknown) => {
            failures.push(error);
            res.destroy();
          }),
        );
      }
    } catch (error: unknown) {
      failures.push(error);
      res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await Promise.all(settlements);
    assert.deepEqual(failures, [], "HTTP fixture handler failed");
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

void test("legacy v1 readers reject suspended wire state and do not gain lifecycle methods", () => {
  assert.equal(c.accountState.safeParse("suspended").success, false);
  assert.equal(
    c.account.safeParse({
      accountRef: "account-a",
      ownerRef: "owner-a",
      profileId: "profile-a",
      displayName: "Fixture",
      state: "suspended",
      metadataRevision: 3,
      authorizationEpoch: 2,
    }).success,
    false,
  );
  assert.deepEqual(
    c.lifecycleAccount.safeParse({
      accountRef: "account-a",
      ownerRef: "owner-a",
      profileId: "profile-a",
      displayName: "Fixture",
      state: "suspended",
      metadataRevision: 3,
      authorizationEpoch: 2,
      authKind: "api_key",
      resumeCustody: "verified",
    }).success,
    true,
  );
  assert.equal(
    "suspend" in
      sdk.createManagementClient({
        origin: "http://127.0.0.1:1",
        role: "management",
        token: "fixture-control-token",
      }),
    false,
  );
});

void test("versioned capability/write gate requires explicit client convergence", async () => {
  const capability = {
    contract: c.LIFECYCLE_CAPABILITY_CONTRACT,
    clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
    writeGate: "enabled",
    operations: ["suspend", "resume"],
    custody: {
      contract: "native-retained-custody/v1",
      api_key: "native-attestation-required",
      oauth: "native-attestation-required",
    },
  };
  assert.deepEqual(c.lifecycleCapability.parse(capability), capability);
  assert.equal(
    c.lifecycleCapability.parse({ ...capability, writeGate: "disabled" }).writeGate,
    "disabled",
  );
  for (const changed of [
    { writeGate: "unknown" },
    { clientContract: "legacy-client/v1" as typeof c.LIFECYCLE_CLIENT_CONTRACT },
    { operations: ["resume", "suspend"] },
    { custody: { ...capability.custody, oauth: "assumed-ready" } },
  ]) {
    assert.equal(c.lifecycleCapability.safeParse({ ...capability, ...changed }).success, false);
  }
  const origin = "http://127.0.0.1:1",
    token = "fixture-control-token";
  assert.throws(
    () =>
      sdk.createLifecycleClient({
        origin,
        role: "management",
        token,
        capability:
          "account-gateway/account-lifecycle/v1" as typeof c.LIFECYCLE_CAPABILITY_CONTRACT,
        clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
      }),
    (error) => error instanceof sdk.GatewayError && error.code === "invalid_input",
  );
  assert.throws(
    () =>
      sdk.createLifecycleClient({
        origin,
        role: "management",
        token,
        capability: c.LIFECYCLE_CAPABILITY_CONTRACT,
        clientContract: "legacy-client/v1" as typeof c.LIFECYCLE_CLIENT_CONTRACT,
      }),
    (error) => error instanceof sdk.GatewayError && error.code === "invalid_input",
  );
});

void test("lifecycle client sends both version gates and strictly binds exact operation/account readback", async (t) => {
  const capability = {
    contract: c.LIFECYCLE_CAPABILITY_CONTRACT,
    clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
    writeGate: "enabled",
    operations: ["suspend", "resume"],
    custody: {
      contract: "native-retained-custody/v1",
      api_key: "native-attestation-required",
      oauth: "native-attestation-required",
    },
  };
  const account = {
    accountRef: "account-a",
    ownerRef: "owner-a",
    profileId: "profile-a",
    displayName: "Fixture",
    state: "suspended",
    metadataRevision: 3,
    authorizationEpoch: 2,
    authKind: "oauth",
    resumeCustody: "attention_required",
  };
  const applied = {
    operationRef: "suspend-a",
    intent: {
      action: "suspend",
      accountRef: "account-a",
      profileId: "profile-a",
      expectedMetadataRevision: 2,
    },
    state: "applied",
    result: { kind: "account_lifecycle", account },
  };
  const observed: (string | undefined)[] = [],
    bodies: unknown[] = [];
  const origin = await fixture(t, async (req, res) => {
    observed.push(req.url);
    assert.equal(req.headers[c.LIFECYCLE_CAPABILITY_HEADER], c.LIFECYCLE_CAPABILITY_CONTRACT);
    assert.equal(req.headers[c.LIFECYCLE_CLIENT_HEADER], c.LIFECYCLE_CLIENT_CONTRACT);
    if (req.method === "POST") {
      bodies.push(JSON.parse(await read(req)));
    }
    if (req.url === "/v2/capabilities/account-lifecycle") {
      json(res, capability);
    } else if (req.url === "/v2/accounts/account-a") {
      json(res, account);
    } else if (req.url === "/v2/accounts/account-a/suspend") {
      json(res, applied);
    } else if (req.url === "/v2/accounts/account-a/resume") {
      json(res, {
        ...applied,
        operationRef: "resume-a",
        intent: { ...applied.intent, action: "resume", expectedMetadataRevision: 3 },
        result: {
          kind: "account_lifecycle",
          account: {
            ...account,
            state: "active",
            metadataRevision: 4,
            authorizationEpoch: 3,
            resumeCustody: "not_applicable",
          },
        },
      });
    } else if (req.url === "/v2/operations/suspend-a") {
      json(res, applied);
    } else {
      json(
        res,
        {
          code: "not_found",
          traceRef: "trace-a",
          effect: "not_dispatched",
          retry: { kind: "never" },
        },
        404,
      );
    }
  });
  const client = sdk.createLifecycleClient({
    origin,
    role: "management",
    token: "fixture-control-token",
    capability: c.LIFECYCLE_CAPABILITY_CONTRACT,
    clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
  });
  assert.deepEqual(await client.capability(), capability);
  assert.deepEqual(await client.get("account-a"), account);
  assert.deepEqual(
    await client.suspend("account-a", { operationId: "suspend-a", expectedMetadataRevision: 2 }),
    applied,
  );
  assert.deepEqual(await client.operation("suspend-a"), applied);
  await client.resume("account-a", { operationId: "resume-a", expectedMetadataRevision: 3 });
  assert.deepEqual(bodies, [
    { operationId: "suspend-a", expectedMetadataRevision: 2 },
    { operationId: "resume-a", expectedMetadataRevision: 3 },
  ]);
  assert.deepEqual(observed, [
    "/v2/capabilities/account-lifecycle",
    "/v2/accounts/account-a",
    "/v2/accounts/account-a/suspend",
    "/v2/operations/suspend-a",
    "/v2/accounts/account-a/resume",
  ]);
});

void test("lifecycle client rejects cross-account responses and missing operation cannot establish no effect", async (t) => {
  const account = {
    accountRef: "foreign-account",
    ownerRef: "owner-a",
    profileId: "profile-a",
    displayName: "Fixture",
    state: "suspended",
    metadataRevision: 3,
    authorizationEpoch: 2,
    authKind: "api_key",
    resumeCustody: "attention_required",
  };
  const origin = await fixture(t, (req, res) => {
    req.resume();
    if (req.url?.startsWith("/v2/operations/") === true) {
      json(
        res,
        {
          code: "not_found",
          traceRef: "trace-a",
          effect: "not_dispatched",
          retry: { kind: "never" },
        },
        404,
      );
    } else if (req.method === "POST") {
      json(res, {
        operationRef: "suspend-a",
        state: "applied",
        intent: {
          action: "suspend",
          accountRef: account.accountRef,
          profileId: account.profileId,
          expectedMetadataRevision: 2,
        },
        result: { kind: "account_lifecycle", account },
      });
    } else {
      json(res, account);
    }
  });
  const client = sdk.createLifecycleClient({
    origin,
    role: "consumer-control",
    token: "fixture-control-token",
    capability: c.LIFECYCLE_CAPABILITY_CONTRACT,
    clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
  });
  const unknown = (error: unknown) =>
    error instanceof sdk.GatewayError && error.effect === "effect_unknown";
  await assert.rejects(client.get("account-a"), unknown);
  await assert.rejects(
    client.suspend("account-a", { operationId: "suspend-a", expectedMetadataRevision: 2 }),
    unknown,
  );
  await assert.rejects(
    client.operation("suspend-a"),
    (error) =>
      unknown(error) &&
      error instanceof sdk.GatewayError &&
      error.diagnostic?.retry.kind === "readback",
  );
});
