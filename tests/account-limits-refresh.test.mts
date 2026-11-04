import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  createAccountLimitsRefreshClient,
  GatewayError,
} from "../packages/account-gateway/dist/http/index.js";
import { createAccountLimitsRefreshClient as rootClient } from "../packages/account-gateway/dist/index.js";

void test("explicit quota refresh uses additive routes and never retries an ambiguous failure", async (t) => {
  let calls = 0;
  const paths: string[] = [];
  const server = createServer((req, res) => {
    calls++;
    paths.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          contract: "account-limits-refresh/v1",
          quotaOnlyRefresh: true,
          profileIds: ["openai-codex-oauth-responses-v1"],
        }),
      );
    } else {
      res.statusCode = 503;
      res.end(JSON.stringify({ secret: "provider-secret" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const client = createAccountLimitsRefreshClient({
    role: "consumer-control",
    origin: `http://127.0.0.1:${address.port}`,
    token: "fixture-token",
  });
  assert.equal(rootClient, createAccountLimitsRefreshClient);
  assert.equal((await client.getAccountLimitsRefreshCapabilities()).quotaOnlyRefresh, true);
  await assert.rejects(
    client.refreshAccountLimits({
      ownerRef: "owner-a",
      accountRef: "account-a",
      profileId: "openai-codex-oauth-responses-v1",
      expectedAuthorizationEpoch: 1,
    }),
    (error: unknown) => error instanceof GatewayError && !String(error).includes("provider-secret"),
  );
  assert.equal(calls, 2);
  assert.deepEqual(paths, [
    "GET /v1/capabilities/account-limits-refresh",
    "POST /v1/account-limits/refresh",
  ]);
});
