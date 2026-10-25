import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  oauthBeginResponse,
  claudeOAuthAuthorizationURL,
  accountOperation,
} from "../packages/account-gateway/dist/contracts/index.js";
import {
  createManagementClient,
  secretSubmission,
  GatewayError,
} from "../packages/account-gateway/dist/http/index.js";

const authorizationURL =
  "https://claude.com/cai/oauth/authorize?" +
  new URLSearchParams({
    code: "true",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    response_type: "code",
    redirect_uri: "https://platform.claude.com/oauth/code/callback",
    code_challenge_method: "S256",
    scope:
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    state: "a".repeat(64),
    code_challenge: "b".repeat(43),
  });

// Red if a provider-supplied capability can change endpoints, scopes, or methods,
// or if a manual completion can be confused with Codex's callback URL.
test("Claude browser handoff and manual authorization code have closed secret contracts", () => {
  assert.equal(claudeOAuthAuthorizationURL.parse(authorizationURL), authorizationURL);
  for (const changed of [
    authorizationURL.replace("claude.com", "fixture.invalid"),
    authorizationURL.replace("code=true", "code=false"),
    authorizationURL + "&client_id=second",
    authorizationURL.replace("scope=", "%73cope="),
    authorizationURL + "&extra=value",
    authorizationURL.replace("state=" + "a".repeat(64), "state=" + "A".repeat(64)),
    authorizationURL.replace("code_challenge=", "code_challenge=%FF"),
    authorizationURL + "#",
  ])
    assert.equal(claudeOAuthAuthorizationURL.safeParse(changed).success, false);
  const value = "fixture-code#" + "a".repeat(64);
  assert.deepEqual(secretSubmission.parseClaudeOAuthAuthorizationCode(value), {
    code: "fixture-code",
    state: "a".repeat(64),
  });
  for (const invalid of [
    value + "#more",
    value.replace("#", " #"),
    "x#" + "a".repeat(63),
    "x#" + "A".repeat(64),
    "x".repeat(8193) + "#" + "a".repeat(64),
    "é".repeat(4097) + "#" + "a".repeat(64),
    "x\u0000#" + "a".repeat(64),
  ])
    assert.equal(secretSubmission.claudeOAuthAuthorizationCode.safeParse(invalid).success, false);
  assert.equal(
    secretSubmission.oauthComplete.safeParse({
      operationId: "op",
      ownerRef: "owner",
      authorizationCode: value,
      callbackURL: value,
    }).success,
    false,
  );
  const pending = { operationRef: "op", state: "pending" as const };
  assert.equal(
    oauthBeginResponse.safeParse({ operation: pending, authorizationURL }).success,
    true,
  );
  assert.equal(accountOperation.safeParse({ ...pending, authorizationURL }).success, false);
  assert.equal(
    oauthBeginResponse.safeParse({
      operation: { ...pending, oauthMethod: "device_code" },
      authorizationURL,
    }).success,
    false,
  );
});

test("Claude SDK sends one secret completion and does not retry a lost acknowledgement", async (t) => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.destroy();
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
    role: "management",
    origin: `http://127.0.0.1:${address.port}`,
    token: "synthetic-control",
  });
  const input = {
    operationId: "op",
    ownerRef: "owner",
    authorizationCode: "fixture-code#" + "a".repeat(64),
  };
  await assert.rejects(
    client.completeOAuth(input),
    (error) => error instanceof GatewayError && error.effect === "effect_unknown",
  );
  assert.deepEqual(requests, [
    { method: "POST", path: "/v1/accounts/oauth/complete", body: input },
  ]);
});
