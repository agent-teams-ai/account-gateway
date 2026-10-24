import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { providerConnectionCapabilities, profile as legacyProfile, accountLimitsV2, grokOAuthAuthorizationURL, codexOAuthAuthorizationURL, claudeOAuthAuthorizationURL, oauthDeviceAuthorization } from '../packages/account-gateway/dist/contracts/index.js';
import { createManagementClient, createConsumerControlClient, createAccountLimitsV2Client, secretSubmission, GatewayError } from '../packages/account-gateway/dist/http/index.js';

test('provider connection projection is versioned, closed and additive to the old strict profile DTO', async t => {
  const legacy = { profileId: 'mimo', protocol: 'openai-chat', modelIds: ['mimo'], authKinds: ['api_key'] };
  assert.equal(legacyProfile.safeParse(legacy).success, true);
  assert.equal(legacyProfile.safeParse({ ...legacy, completionInputKind: 'none' }).success, false);

  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, '/v1/provider-connection-capabilities');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ contract: 'provider-connections/v1', capabilities: [{
      contract: 'provider-connections/v1', profileId: 'glm-coding-global-responses-apikey-v1',
      provider: { identity: 'glm', label: 'GLM Coding Plan' },
      plan: { identity: 'coding_plan', label: 'GLM Coding Plan' },
      region: { identity: 'global', label: 'Global' }, protocol: 'openai-responses',
      modelIds: ['glm-5.3-flash'], authMethods: ['api_key'], completionInputKind: 'none',
      availability: 'enabled', oauthCallbackMode: null, reconnect: 'replace_api_key',
      limitsContract: 'account-limits/v2',
      models: [{ modelId: 'glm-5.3-flash', reasoning: null,
        fast: null, tools: { allowed: ['function'], default: 'function' } }],
    }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = createManagementClient({ role: 'management', origin: `http://127.0.0.1:${address.port}`, token: 'fixture-token' });
  const result = await client.getProviderConnectionCapabilities();
  const consumer = createConsumerControlClient({ role: 'consumer-control', origin: `http://127.0.0.1:${address.port}`, token: 'fixture-token' });
  assert.deepEqual(await consumer.getProviderConnectionCapabilities(), result);
  assert.equal(requests, 2);
  assert.equal(providerConnectionCapabilities.safeParse(result).success, true);
  assert.equal(result.capabilities[0].models[0].reasoning, null);
  assert.equal(JSON.stringify(result).includes('client_secret'), false);
  assert.equal(JSON.stringify(result).includes('cli-chat-proxy.grok.com'), false);
});

test('capability client never converts 401, 403 or unsupported-contract into legacy discovery', async t => {
  for (const status of [401, 403, 404]) {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: status === 404 ? 'not_found' : 'forbidden', traceRef: 'trace-a', effect: 'not_dispatched', retry: { kind: 'never' } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const client = createManagementClient({ role: 'management', origin: `http://127.0.0.1:${address.port}`, token: 'fixture-token' });
    await assert.rejects(client.getProviderConnectionCapabilities(), error => error instanceof GatewayError && error.code === 'safe_error' && error.httpStatus === status);
    assert.equal(requests, 1);
  }
});

test('account-limits/v2 keeps closed units and periods in the validated wire contract', async t => {
  const input = { ownerRef: 'owner-a', accountRef: 'account-a', profileId: 'glm-coding-global-responses-apikey-v1', expectedAuthorizationEpoch: 3 };
  const snapshot = { status: 'snapshot' as const, physicalGeneration: 'birth-a', principalVersion: 'principal-a', revision: 2,
    scope: 'subscription' as const, windows: [
      { id: 'five_hour' as const, provider: 'glm' as const, dimension: 'plan_quota' as const, unit: 'credits' as const,
        period: { kind: 'duration' as const, durationSeconds: 18000 }, label: '5h' as const,
        usedPercent: null, observedAt: '2026-10-23T01:02:03Z', resetAt: null },
      { id: 'monthly' as const, provider: 'glm' as const, dimension: 'plan_quota' as const, unit: 'tokens' as const,
        period: { kind: 'monthly_billing_cycle' as const }, label: 'Month' as const,
        usedPercent: 25, observedAt: null, resetAt: '2026-11-03T01:02:03Z' },
    ] };
  let result: unknown = snapshot, requests = 0, v1Requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v2/capabilities/account-limits') {
      response.end(JSON.stringify({ contract: 'account-limits/v2', cachedRead: true, quotaOnlyRefresh: false })); return;
    }
    assert.equal(request.url, '/v2/account-limits/read');
    response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createAccountLimitsV2Client({ role: 'management', origin, token: 'fixture-token', contract: 'account-limits/v2' });
  assert.deepEqual(await client.getAccountLimitsCapabilities(), { contract: 'account-limits/v2', cachedRead: true, quotaOnlyRefresh: false });
  assert.deepEqual(await client.readAccountLimits(input), snapshot);
  assert.equal(v1Requests, 0, 'declared v2 never probes v1');
  const consumer = await client.readAccountLimits(input);
  assert.equal(consumer.status, 'snapshot');
  assert.deepEqual(consumer.status === 'snapshot' ? consumer.windows.map(window => [window.unit, window.period.kind]) : [],
    [['credits', 'duration'], ['tokens', 'monthly_billing_cycle']]);
  result = { ...snapshot, windows: [] };
  await assert.rejects(client.readAccountLimits(input), error => error instanceof GatewayError && error.code === 'invalid_response');
  for (const patch of [{ label: 'Month', period: { kind: 'duration', durationSeconds: 2592000 } },
    { label: '5h', period: { kind: 'unknown' } }]) {
    assert.equal(accountLimitsV2.safeParse({ ...snapshot, windows: [{ ...snapshot.windows[0], ...patch }] }).success, false);
  }
  assert.equal(requests, 4);
});


test('Grok handoff accepts only the qualified OIDC browser grammar', () => {
  const params = new URLSearchParams({ client_id: 'qualified-client', response_type: 'code',
    redirect_uri: 'http://127.0.0.1:56121/callback', scope: 'openid profile email offline_access grok-cli:access api:access',
    code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'a'.repeat(64), nonce: 'b'.repeat(43) });
  const url = 'https://auth.x.ai/oauth2/authorize?' + params;
  assert.equal(grokOAuthAuthorizationURL.safeParse(url).success, true);
  for (const invalid of [url.replace('auth.x.ai', 'accounts.x.ai'), url + '&state=other',
    url.replace('nonce=', 'secret='), url.replace('S256', 'plain'), url + '#fragment'])
    assert.equal(grokOAuthAuthorizationURL.safeParse(invalid).success, false);
});


test('Grok callback rejects decoded delimiters before the secret HTTP submission', () => {
  const state = 'a'.repeat(64);
  for (const code of ['fixture%23fragment', 'fixture%3Fquery', 'fixture%26field']) {
    const callbackURL = 'http://127.0.0.1:56121/callback?code=' + code + '&state=' + state;
    assert.equal(secretSubmission.parseGrokManualCallbackURL(callbackURL), undefined);
    assert.equal(secretSubmission.oauthComplete.safeParse({ operationId: 'fixture-op', ownerRef: 'fixture-owner', callbackURL }).success, false);
  }
});


test('legacy Codex and Claude handoffs retain independent official authorization scopes and device contract', () => {
  const state = 'a'.repeat(64), challenge = 'b'.repeat(43);
  const codexParams = new URLSearchParams({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', response_type: 'code',
    redirect_uri: 'http://localhost:1455/auth/callback', code_challenge_method: 'S256',
    scope: 'openid profile email offline_access', state, code_challenge: challenge });
  const codex = 'https://auth.openai.com/oauth/authorize?' + codexParams;
  assert.equal(codexOAuthAuthorizationURL.safeParse(codex).success, true);
  assert.equal(codexOAuthAuthorizationURL.safeParse(codex.replace('offline_access', 'offline_access+grok-cli%3Aaccess+api%3Aaccess')).success, false);
  const claudeParams = new URLSearchParams({ code: 'true', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', response_type: 'code',
    redirect_uri: 'https://platform.claude.com/oauth/code/callback', code_challenge_method: 'S256',
    scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload', state, code_challenge: challenge });
  const claude = 'https://claude.com/cai/oauth/authorize?' + claudeParams;
  assert.equal(claudeOAuthAuthorizationURL.safeParse(claude).success, true);
  assert.equal(codexOAuthAuthorizationURL.safeParse(claude).success, false);
  assert.equal(claudeOAuthAuthorizationURL.safeParse(codex).success, false);
  assert.equal(grokOAuthAuthorizationURL.safeParse(codex).success, false);
  assert.equal(grokOAuthAuthorizationURL.safeParse(claude).success, false);
  const device = { userCode: 'ABCD-EFGH', verificationURL: 'https://auth.openai.com/codex/device',
    expiresAt: '2026-10-23T12:00:00Z', intervalSeconds: 5 };
  assert.equal(oauthDeviceAuthorization.safeParse(device).success, true);
  assert.equal(oauthDeviceAuthorization.safeParse({ ...device, verificationURL: 'https://auth.x.ai/device' }).success, false);
});


test('Grok plain code shares callback lexical bounds and strict completion ingress', () => {
  for (const code of ['displayed-code', 'a'.repeat(4096), 'valid+code=part']) {
    assert.equal(secretSubmission.grokOAuthAuthorizationCode.safeParse(code).success, true);
    assert.equal(secretSubmission.oauthComplete.safeParse({ operationId: 'operation-a', ownerRef: 'owner-a', authorizationCode: code }).success, true);
  }
  for (const code of ['', 'a'.repeat(4097), 'é'.repeat(2049), ' leading', 'trailing ', 'code#state', 'code?x', 'code&x', '\ncode', '\ud800'])
    assert.equal(secretSubmission.grokOAuthAuthorizationCode.safeParse(code).success, false);
  assert.equal(secretSubmission.oauthComplete.safeParse({ operationId: 'operation-a', ownerRef: 'owner-a', authorizationCode: 'displayed-code', state: 'a'.repeat(64) }).success, false);
  assert.equal(secretSubmission.claudeOAuthAuthorizationCode.safeParse('displayed-code').success, false);
  assert.equal(secretSubmission.claudeOAuthAuthorizationCode.safeParse('displayed-code#' + 'a'.repeat(64)).success, true);
});
