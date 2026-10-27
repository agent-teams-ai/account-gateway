import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  createAccountLimitsClient,
  createAccountLimitsV2Client,
  createConsumerControlClient,
  secretSubmission,
} from "@agent-teams/account-gateway/http";
import {
  accountLimitsCapabilities,
  accountLimitsRequest,
  accountLimitsResult,
  accountLimitsV2,
  providerConnectionCapabilities,
  codexOAuthAuthorizationURL,
  claudeOAuthAuthorizationURL,
  grokOAuthAuthorizationURL,
} from "@agent-teams/account-gateway/contracts";

const browserState = "a".repeat(64),
  browserChallenge = "b".repeat(43);
const codexHandoff =
  "https://auth.openai.com/oauth/authorize?" +
  new URLSearchParams({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    response_type: "code",
    redirect_uri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    code_challenge_method: "S256",
    code_challenge: browserChallenge,
    state: browserState,
  });
assert.equal(codexOAuthAuthorizationURL.safeParse(codexHandoff).success, true);
const claudeHandoff =
  "https://claude.com/cai/oauth/authorize?" +
  new URLSearchParams({
    code: "true",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    response_type: "code",
    redirect_uri: "https://platform.claude.com/oauth/code/callback",
    scope:
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    code_challenge_method: "S256",
    code_challenge: browserChallenge,
    state: browserState,
  });
assert.equal(claudeOAuthAuthorizationURL.safeParse(claudeHandoff).success, true);
assert.equal(grokOAuthAuthorizationURL.safeParse(codexHandoff).success, false);
assert.equal(grokOAuthAuthorizationURL.safeParse(claudeHandoff).success, false);
assert.equal(typeof createAccountLimitsClient, "function");
assert.equal(typeof createAccountLimitsV2Client, "function");
assert.equal(
  (await import("@agent-teams/account-gateway")).createAccountLimitsV2Client,
  createAccountLimitsV2Client,
);
assert.equal(
  typeof createConsumerControlClient({
    role: "consumer-control",
    origin: "http://127.0.0.1:43123",
    token: "fixture-token",
  }).getProviderConnectionCapabilities,
  "function",
);
assert.deepEqual(
  providerConnectionCapabilities.parse({ contract: "provider-connections/v1", capabilities: [] }),
  { contract: "provider-connections/v1", capabilities: [] },
);
assert.deepEqual(accountLimitsV2.parse({ status: "unknown" }), { status: "unknown" });
const grokState = "a".repeat(64);
assert.deepEqual(
  secretSubmission.parseGrokManualCallbackURL(
    "http://127.0.0.1:56121/callback?code=fixture&state=" + grokState,
  ),
  { code: "fixture", state: grokState },
);
for (const code of ["fixture%23fragment", "fixture%3Fquery", "fixture%26field"]) {
  assert.equal(
    secretSubmission.parseGrokManualCallbackURL(
      "http://127.0.0.1:56121/callback?code=" + code + "&state=" + grokState,
    ),
    undefined,
  );
}
const authorizationCode = "fixture-code#" + "a".repeat(64);
assert.deepEqual(secretSubmission.parseClaudeOAuthAuthorizationCode(authorizationCode), {
  code: "fixture-code",
  state: "a".repeat(64),
});
assert.equal(
  secretSubmission.oauthComplete.safeParse({
    operationId: "fixture-op",
    ownerRef: "fixture-owner",
    authorizationCode,
  }).success,
  true,
);
assert.equal(
  secretSubmission.oauthComplete.safeParse({
    operationId: "fixture-op",
    ownerRef: "fixture-owner",
    authorizationCode,
    callbackURL: authorizationCode,
  }).success,
  false,
);
assert.equal(
  (await import("@agent-teams/account-gateway")).createAccountLimitsClient,
  createAccountLimitsClient,
);
assert.equal(
  accountLimitsCapabilities.safeParse({
    contract: "account-limits/v1",
    cachedRead: true,
    quotaOnlyRefresh: false,
  }).success,
  true,
);
assert.equal(
  accountLimitsRequest.safeParse({
    ownerRef: "owner-fixture",
    accountRef: "account-fixture",
    profileId: "openai-codex-oauth-responses-v1",
    expectedAuthorizationEpoch: 2,
  }).success,
  true,
);
assert.deepEqual(accountLimitsResult.parse({ status: "unknown" }), { status: "unknown" });
const snapshot = {
  status: "snapshot",
  physicalGeneration: "birth-fixture",
  principalVersion: "principal-fixture",
  revision: 1,
  scope: "subscription",
  windows: [
    {
      id: "codex-primary",
      family: "codex",
      durationSeconds: 18000,
      usedPercent: 137.5,
      observedAt: "2026-10-22T09:00:00Z",
      resetAt: "2026-10-22T10:00:00Z",
      basis: "duration",
    },
  ],
};
assert.deepEqual(accountLimitsResult.parse(snapshot), snapshot);
assert.equal(
  accountLimitsResult.safeParse({
    ...snapshot,
    windows: [{ ...snapshot.windows[0], usedPercent: -1 }],
  }).success,
  false,
);
assert.equal(
  accountLimitsResult.safeParse({ ...snapshot, credentials: "private-fixture" }).success,
  false,
);
assert.equal(
  accountLimitsResult.safeParse({ status: "unknown", windows: snapshot.windows }).success,
  false,
);

const claude = {
  ...snapshot,
  windows: [
    { ...snapshot.windows[0], id: "claude-5h", family: "claude", usedPercent: 37.5 },
    {
      ...snapshot.windows[0],
      id: "claude-7d-sonnet",
      family: "claude",
      durationSeconds: 604800,
      usedPercent: null,
    },
  ],
};
assert.deepEqual(accountLimitsResult.parse(claude), claude);
assert.equal(
  accountLimitsResult.safeParse({
    ...claude,
    windows: [{ ...claude.windows[0], id: "claude-7d-opus" }],
  }).success,
  false,
);
assert.equal(
  accountLimitsResult.safeParse({ ...claude, windows: [...claude.windows, snapshot.windows[0]] })
    .success,
  false,
);
writeFileSync(
  "limits-closure.mts",
  `import {createAccountLimitsClient,createAccountLimitsV2Client,createManagementClient,createConsumerControlClient} from '@agent-teams/account-gateway/http';
import type {AccountLimitsClient,AccountLimitsConfig,AccountLimitsV2Client,AccountLimitsV2Config} from '@agent-teams/account-gateway/http';
import type {AccountLimitsRequest,AccountLimitsResult,AccountLimitsCapabilities,AccountLimitsV2,ProviderConnectionCapabilities} from '@agent-teams/account-gateway/contracts';
export function read(config:AccountLimitsConfig,input:AccountLimitsRequest):Promise<AccountLimitsResult> {
 const client:AccountLimitsClient=createAccountLimitsClient(config);
 return client.readAccountLimits(input);
}
export function capabilities(client:AccountLimitsClient):Promise<AccountLimitsCapabilities> {return client.getAccountLimitsCapabilities();}
export function complete(config:AccountLimitsConfig,authorizationCode:string) {
 const client=createManagementClient({...config,role:'management'});
 return client.completeOAuth({operationId:'fixture-op',ownerRef:'fixture-owner',authorizationCode});
}
export function readV2(config:AccountLimitsV2Config,input:AccountLimitsRequest):Promise<AccountLimitsV2> {
 const client:AccountLimitsV2Client=createAccountLimitsV2Client(config);return client.readAccountLimits(input);
}
export function providerCapabilities(config:AccountLimitsConfig):Promise<ProviderConnectionCapabilities> {
 return createConsumerControlClient({...config,role:'consumer-control'}).getProviderConnectionCapabilities();
}
export function windows(value:AccountLimitsResult):number|null {
 return value.status==='snapshot' ? value.windows[0]?.usedPercent ?? null : null;
}
`,
);
const typed = spawnSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2023",
    "--strict",
    "--skipLibCheck",
    "false",
    "--types",
    "node",
    "--outDir",
    "compiled-limits",
    "limits-closure.mts",
  ],
  { stdio: "inherit" },
);
assert.equal(typed.status, 0);
const blocked = spawnSync(
  process.execPath,
  ["--conditions=browser", "--input-type=module", "-e", "import '@agent-teams/account-gateway'"],
  { encoding: "utf8" },
);
assert.notEqual(blocked.status, 0);
assert.match(blocked.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
console.log("PASS installed account-limits exports, bounded contract and TypeScript closure");
