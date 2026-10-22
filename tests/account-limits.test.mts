import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAccountLimitsClient, GatewayError } from '../packages/account-gateway/dist/http/index.js';
import { createAccountLimitsClient as rootClient } from '../packages/account-gateway/dist/index.js';
import { accountLimitsResult } from '../packages/account-gateway/dist/contracts/index.js';

// Regression: a provider-shaped payload, offsets, unsafe revisions or zero invented
// from null could otherwise become an apparently valid numeric account quota.
test('cached limits HTTP keeps canonical partial/overage facts and rejects unsafe wire data', async t => {
  const input = { ownerRef: 'owner-a', accountRef: 'account-a', profileId: 'codex', expectedAuthorizationEpoch: 3 };
  const snapshot = { status: 'snapshot' as const, physicalGeneration: 'generation-a', principalVersion: 'principal-a',
    revision: 2, scope: 'account' as const, windows: [{ id: 'primary', family: 'codex' as const, durationSeconds: 18000,
      usedPercent: 137.5, observedAt: '2026-10-22T01:02:03.123456789Z', resetAt: null, basis: 'duration' as const }] };
  let result: unknown = snapshot, calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      assert.equal(req.url, '/v1/capabilities/account-limits');
      res.end(JSON.stringify({ contract: 'account-limits/v1', cachedRead: true, quotaOnlyRefresh: false })); return;
    }
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/account-limits/read');
    const chunks: Buffer[] = []; for await (const bytes of req) chunks.push(Buffer.from(bytes as Uint8Array));
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), input);
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const cfg = { role: 'consumer-control' as const, origin: `http://127.0.0.1:${address.port}`, token: 'fixture-token' };
  const client = createAccountLimitsClient(cfg);
  assert.equal(rootClient, createAccountLimitsClient);
  assert.deepEqual(await client.getAccountLimitsCapabilities(), { contract: 'account-limits/v1', cachedRead: true, quotaOnlyRefresh: false });
  assert.deepEqual(await client.readAccountLimits(input), snapshot);
  assert.deepEqual(await createAccountLimitsClient({ ...cfg, role: 'management' }).readAccountLimits(input), snapshot);
  for (const usedPercent of [0, 37.5, null]) {
    result = { ...snapshot, windows: [{ ...snapshot.windows[0], usedPercent }] };
    assert.deepEqual(await client.readAccountLimits(input), result);
  }
  for (const status of ['unknown', 'unsupported', 'unavailable']) {
    result = { status }; assert.deepEqual(await client.readAccountLimits(input), result);
  }
  const invalid = [
    { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, email: 'private-sentinel' },
    { ...snapshot, windows: Array(9).fill(snapshot.windows[0]) },
    ...[-1, '37.5', Infinity].map(usedPercent => ({ ...snapshot, windows: [{ ...snapshot.windows[0], usedPercent }] })),
    ...['2026-10-22T01:02:03+00:00', '2026-02-30T01:02:03Z', 'now'].map(observedAt => ({ ...snapshot, windows: [{ ...snapshot.windows[0], observedAt }] })),
  ];
  // Infinity cannot travel as JSON numeric data (it becomes null); the schema
  // still rejects it before JSON serialization on native-facing boundaries.
  assert.equal(accountLimitsResult.safeParse(invalid[5]).success, false);
  for (const value of invalid.filter((_, i) => i !== 5)) {
    result = value;
    await assert.rejects(client.readAccountLimits(input), e => e instanceof GatewayError && e.code === 'invalid_response');
  }
  const before = calls;
  assert.throws(() => client.readAccountLimits({ ...input, expectedAuthorizationEpoch: -1 }), e => e instanceof GatewayError && e.code === 'invalid_input');
  assert.equal(calls, before, 'invalid selectors never enter HTTP');
  for (const changed of [{ timeoutMs: 3001 }, { responseBytes: 262145 }])
    assert.throws(() => createAccountLimitsClient({ ...cfg, ...changed }), GatewayError);
});
