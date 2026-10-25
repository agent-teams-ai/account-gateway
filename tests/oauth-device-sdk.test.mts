import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import * as c from "../packages/account-gateway/dist/contracts/index.js";
import {
  createManagementClient,
  GatewayError,
} from "../packages/account-gateway/dist/http/index.js";

const handoff: c.OAuthDeviceAuthorization = {
  userCode: "ABCD-EFGH",
  verificationURL: "https://auth.openai.com/codex/device",
  expiresAt: "2099-01-01T00:00:00Z",
  intervalSeconds: 5,
};
const pending = {
  operationRef: "device-op",
  state: "pending" as const,
  oauthMethod: "device_code" as const,
};

// Regression: accepting native IDs/unknown origins or handoff fields in an
// ordinary operation would turn safe receipts into credential-bearing storage.
test("device contracts isolate transient handoff from ordinary operation receipts", () => {
  const begin = { operation: pending, deviceAuthorization: handoff };
  assert.deepEqual(c.oauthBeginResponse.parse(begin), begin);
  for (const changed of [
    { verificationURL: "https://fixture.invalid/device" },
    { deviceAuthId: "private-id" },
    { userCode: "bad code" },
    { intervalSeconds: 0 },
    { expiresAt: "invalid" },
  ]) {
    assert.equal(
      c.oauthBeginResponse.safeParse({ ...begin, deviceAuthorization: { ...handoff, ...changed } })
        .success,
      false,
    );
  }
  assert.equal(
    c.accountOperation.safeParse({ ...pending, deviceAuthorization: handoff }).success,
    false,
  );
  assert.equal(
    c.oauthBeginResponse.safeParse({ ...begin, operation: { ...pending, state: "unknown" } })
      .success,
    false,
  );
  assert.equal(
    c.oauthBeginResponse.safeParse({
      ...begin,
      operation: { operationRef: pending.operationRef, state: "pending" },
    }).success,
    false,
  );
  assert.equal(
    c.oauthPoll.safeParse({ operationId: "device-op", ownerRef: "owner", userCode: "ABCD-EFGH" })
      .success,
    false,
  );
});

test("SDK polls only explicit POST and never retries ambiguous device dispatch", async (t) => {
  const requests: { path: string | undefined; method: string | undefined; body?: unknown }[] = [];
  let loseACK = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      method: req.method,
      ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString()) } : {}),
    });
    assert.equal(req.headers.authorization, "Bearer synthetic-control");
    if (loseACK) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url?.endsWith("/begin")
          ? { operation: pending, deviceAuthorization: handoff }
          : pending,
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createManagementClient({
    origin: `http://127.0.0.1:${address.port}`,
    role: "management",
    token: "synthetic-control",
  });
  const begin = {
    operationId: "device-op",
    ownerRef: "owner",
    profileId: "oauth-profile",
    displayName: "Fixture",
    method: "device_code" as const,
  };
  assert.deepEqual((await client.beginOAuth(begin)).deviceAuthorization, handoff);
  assert.deepEqual(await client.readOAuth("device-op"), pending);
  const poll = { operationId: "device-op", ownerRef: "owner" };
  assert.deepEqual(await client.pollDeviceOAuth(poll), pending);
  assert.deepEqual(requests, [
    { path: "/v1/accounts/oauth/begin", method: "POST", body: begin },
    { path: "/v1/operations/device-op", method: "GET" },
    { path: "/v1/accounts/oauth/poll", method: "POST", body: poll },
  ]);
  loseACK = true;
  await assert.rejects(
    client.pollDeviceOAuth(poll),
    (e) => e instanceof GatewayError && e.effect === "effect_unknown",
  );
  assert.equal(
    requests.length,
    4,
    "lost ACK neither retries poll nor invokes Begin/read automatically",
  );
});
