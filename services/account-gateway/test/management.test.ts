import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { IntentSecrets } from '../src/management-store.ts';
import { NativeFailure, NativeManagementClient, NativeRetainedCustodyClient, NativeOAuthEnrollmentClient, NativeOAuthLifecycleClient } from '../src/native-client.ts';
import { physicalCandidate, codexOAuthProfile } from '../src/management.ts';
import type { CandidateJournal, CandidateScope, PhysicalCandidate, OAuthScope } from '../src/management.ts';
import { KernelError } from '../src/domain.ts';

const scope = (): CandidateScope => ({ consumerId: 'synthetic-consumer', operationId: 'operation-fixture',
  accountRef: randomUUID(), ownerRef: 'workspace-fixture', purpose: 'create' });
const secrets = (): IntentSecrets => new IntentSecrets(randomBytes(32),randomBytes(32));
const journal = (): CandidateJournal => ({ ...scope(), generation: randomUUID(), worker: randomUUID(),
  profile: { profile: 'synthetic-profile', baseURL: 'https://fixture.invalid/v1', model: 'fixture-model', qualificationRef: 'fixture-only' } });
const descriptor = (j: CandidateJournal): PhysicalCandidate => ({ generation: j.generation,
  nativePhysicalIdentity: j.generation, nativeId: 734, createdAt: '2026-10-03T04:05:06.123456789+00:00',
  profile: j.profile.profile, baseURL: j.profile.baseURL, model: j.profile.model });
// Existing GatewayNativeCandidate/GatewayNativeRoute JSON, from supplied Go source.
function nativeBody(d: PhysicalCandidate, state: 'inactive' | 'active' = 'inactive'): object {
  return { descriptor: { account_id: d.nativeId,generation: d.generation,created_at: d.createdAt,
    profile: d.profile,base_url: d.baseURL,model: d.model },name: 'Disposable fixture',state,
    group_free: true,schedulable: false,probes_enabled: false };
}
async function local(handler: (req: IncomingMessage,res: ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { origin: 'http://127.0.0.1:' + address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const client = (origin: string, options: { deadlineMs?: number; bodyBytes?: number } = {}): NativeManagementClient =>
  new NativeManagementClient({ origin, consumerId: 'synthetic-consumer', controlCredential: 'synthetic-control', ...options });
const code = (expected: string) => (e: unknown): boolean => e instanceof NativeFailure && e.code === expected && e.classification === 'uncertain';

// A native peer returning a device identifier, substituted provider origin or
// replayed handoff must fail before any capability reaches a consumer.
test('device native boundary validates fresh handoff and keeps read/poll scope secret-free', async () => {
  const j = journal(), wire = { operation: j.operationId, owner_ref: j.ownerRef, account_ref: j.accountRef, generation: j.generation };
  const handoff = { user_code: 'ABCD-EFGH', verification_url: 'https://auth.openai.com/codex/device',
    expires_at: '2099-01-01T00:00:00Z', interval_seconds: 5 };
  const ack = { operation: j.operationId, account_ref: j.accountRef, state: 'prepared', method: 'device_code' };
  let response: unknown = { ...ack, device_authorization: handoff };
  const requests: { path: string | undefined; body: unknown }[] = [];
  const server = await local((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.end(JSON.stringify(response));
    });
  });
  try {
    const client = new NativeOAuthEnrollmentClient({ origin: server.origin, consumerId: j.consumerId,
      ownerRef: j.ownerRef, controlCredential: 'synthetic-control' });
    assert.deepEqual((await client.begin(j, 'device_code')).deviceAuthorization, { userCode: 'ABCD-EFGH',
      verificationURL: 'https://auth.openai.com/codex/device', expiresAt: '2099-01-01T00:00:00Z', intervalSeconds: 5 });
    assert.deepEqual(requests[0], { path: '/private/native/v1/oauth/connect', body: { ...wire, method: 'device_code' } });
    for (const patch of [{ verification_url: 'https://fixture.invalid/device' }, { user_code: 'bad code' },
      { interval_seconds: 0 }, { device_auth_id: 'synthetic-private-id' }, { expires_at: 'invalid' }]) {
      response = { ...ack, device_authorization: { ...handoff, ...patch } };
      await assert.rejects(client.begin(j, 'device_code'), code('invalid_readback'));
    }
    response = { ...ack, device_authorization: handoff };
    await assert.rejects(client.read(j), code('invalid_readback'));
    await assert.rejects(client.poll(j), code('invalid_readback'));
    response = ack;
    assert.equal((await client.read(j)).state, 'prepared');
    assert.equal((await client.poll(j)).state, 'prepared');
    assert.deepEqual(requests.slice(-2), [{ path: '/private/native/v1/oauth/connect/read', body: wire },
      { path: '/private/native/v1/oauth/connect/poll', body: wire }]);
    const calls = requests.length;
    await assert.rejects(client.poll({ ...j, ownerRef: 'other-owner' }), code('denied'));
    assert.equal(requests.length, calls, 'owner mismatch never enters HTTP');
  } finally { await server.close(); }
});

// RED on the former TS adapter with actual Go handler first and cached success
// bodies. Root produces these using the native signed-custody/account-check test.
const joinedFixture = process.env.AG_OAUTH_JOINED_DESCRIPTOR_FIXTURE_DIR;
test('joined Go protected descriptor first and cached success reaches TS consumer', { skip: !joinedFixture }, async () => {
  assert.ok(joinedFixture && isAbsolute(joinedFixture));
  const scope = JSON.parse(await readFile(join(joinedFixture, 'scope.json'), 'utf8')) as OAuthScope;
  const expected = JSON.parse(await readFile(join(joinedFixture, 'expected.json'), 'utf8')) as {
    account_id: number; generation: string; created_at: string; profile: string; base_url: string; model: string };
  // Independent accepted fixture birth, not computed from the response/parser.
  assert.equal(expected.account_id, 42); assert.equal(expected.created_at, '2026-10-08T12:34:56.123456Z');
  assert.equal(expected.profile, codexOAuthProfile.profile); assert.equal(expected.base_url, codexOAuthProfile.baseURL);
  assert.equal(expected.model, codexOAuthProfile.model); assert.equal(expected.generation, scope.generation);
  let response = await readFile(join(joinedFixture, 'first.json'));
  const server = await local((req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/private/native/v1/oauth/connect/descriptor');
    req.resume(); req.on('end', () => res.end(response));
  });
  try {
    const client = new NativeOAuthEnrollmentClient({ origin: server.origin, consumerId: scope.consumerId,
      ownerRef: scope.ownerRef, controlCredential: 'joined-fixture-control' });
    for (const file of ['first.json', 'cached.json']) {
      response = await readFile(join(joinedFixture, file));
      assert.deepEqual(await client.describe(scope), { operationId: scope.operationId, accountRef: scope.accountRef,
        state: 'qualified', qualification: 'controlled-source-v1', native: { nativeId: expected.account_id,
          generation: scope.generation, nativePhysicalIdentity: scope.generation, createdAt: expected.created_at,
          profile: codexOAuthProfile.profile, baseURL: codexOAuthProfile.baseURL, model: codexOAuthProfile.model } });
    }
  } finally { await server.close(); }
});

// Regression: the genuine staged/source-qualified tuple was rejected, while
// fabricated qualified/qualified or substituted birth could gain admission.
test('OAuth descriptor HTTP accepts native provenance and denies other finite tuples', async () => {
  const j = { ...journal(), profile: { ...codexOAuthProfile, qualificationRef: 'fixture-only' } }, d = descriptor(j);
  const native = { account_id: d.nativeId, generation: d.generation, created_at: d.createdAt,
    profile: d.profile, base_url: d.baseURL, model: d.model };
  const success = { operation: j.operationId, account_ref: j.accountRef, state: 'staged', qualification: 'controlled-source-v1', native };
  let response = JSON.stringify(success);
  const server = await local((req, res) => {
    assert.equal(req.url, '/private/native/v1/oauth/connect/descriptor');
    assert.equal(req.headers.authorization, 'Bearer synthetic-control');
    req.resume(); req.on('end', () => res.end(response));
  });
  try {
    const oauth = new NativeOAuthEnrollmentClient({ origin: server.origin, consumerId: j.consumerId,
      ownerRef: j.ownerRef, controlCredential: 'synthetic-control' });
    assert.deepEqual(await oauth.describe(j), { operationId: j.operationId, accountRef: j.accountRef,
      state: 'qualified', qualification: 'controlled-source-v1', native: d });
    const { native: _native, ...pending } = { ...success, qualification: 'pending' };
    response = JSON.stringify(pending);
    assert.deepEqual(await oauth.describe(j), { operationId: j.operationId, accountRef: j.accountRef, state: 'staged', qualification: 'pending' });
    for (const invalid of [{ ...success, qualification: 'pending' }, { ...success, state: 'qualified', qualification: 'qualified' },
      { ...success, qualification: 'arbitrary' }, { ...success, operation: 'foreign' }, { ...success, account_ref: randomUUID() },
      ...[{ generation: randomUUID() }, { profile: 'other' }, { base_url: 'https://fixture.invalid' }, { model: 'other' }]
        .map(change => ({ ...success, native: { ...native, ...change } }))]) {
      response = JSON.stringify(invalid); await assert.rejects(oauth.describe(j), code('invalid_readback'));
    }
    response = JSON.stringify(success).replace('"account_id":734', '"account_id":9007199254740993');
    await assert.rejects(oauth.describe(j), code('invalid_readback'));
    response = JSON.stringify(success).replace('"qualification":', '"qualification":"controlled-source-v1","qualifica\\u0074ion":');
    await assert.rejects(oauth.describe(j), code('invalid_readback'));
  } finally { await server.close(); }
});

// Regression: credential erasure was treated as transport/effect closure, or
// cleanup sent native IDs/private enrollment operations instead of scoped claims.
test('OAuth cleanup HTTP preserves erased-but-unknown and validates closed receipts', async () => {
  const j = { ...journal(), profile: { ...codexOAuthProfile, qualificationRef: 'fixture-only' } }, d = descriptor(j);
  const authority = { cleanupRef: randomUUID(), cleanupToken: randomUUID() };
  const native = { account_id: d.nativeId, generation: d.generation, created_at: d.createdAt,
    profile: d.profile, base_url: d.baseURL, model: d.model };
  const receipt = { operation: j.operationId, account_ref: j.accountRef, credentials_erased: true, closure: 'unknown', native };
  let response = JSON.stringify(receipt);
  const server = await local((req, res) => {
    assert.equal(req.url, '/private/native/v1/oauth/connect/cleanup'); assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer synthetic-cleanup');
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { operation: j.operationId,
        owner_ref: j.ownerRef, account_ref: j.accountRef, generation: j.generation,
        action: 'erase', cleanup_ref: authority.cleanupRef, cleanup_token: authority.cleanupToken });
      res.end(response);
    });
  });
  try {
    const client = new NativeOAuthLifecycleClient({ origin: server.origin, consumerId: j.consumerId,
      ownerRef: j.ownerRef, controlCredential: 'synthetic-cleanup' });
    assert.deepEqual(await client.cleanup(j, authority, 'erase'), { operationId: j.operationId, accountRef: j.accountRef,
      credentialsErased: true, closure: 'unknown', native: d });
    const { native: _native, ...unbound } = { ...receipt, closure: 'closed' };
    response = JSON.stringify(unbound);
    assert.deepEqual(await client.cleanup(j, authority, 'erase'), { operationId: j.operationId, accountRef: j.accountRef,
      credentialsErased: true, closure: 'closed' });
    for (const invalid of [{ ...receipt, credentials_erased: false, closure: 'closed' }, { ...receipt, closure: 'completed' },
      { ...receipt, generation: j.generation }, { ...receipt, account_ref: randomUUID() },
      { ...receipt, native: { ...native, generation: randomUUID() } }]) {
      response = JSON.stringify(invalid); await assert.rejects(client.cleanup(j, authority, 'erase'), code('invalid_readback'));
    }
  } finally { await server.close(); }
});

// Regression: rebinding ciphertext to another scope or altering GCM bytes must never disclose a key.
test('transient AEAD binds every scope primitive and rejects tamper and server key rotation', () => {
  const custody = secrets(), s = scope(), envelope = custody.seal(s,'fixture-key');
  assert.equal(custody.open(s,envelope) === 'fixture-key',true);
  for (const changed of [{ ...s, consumerId: 'other' },{ ...s, operationId: 'other' },
    { ...s, accountRef: randomUUID() },{ ...s, ownerRef: 'other' },{ ...s, purpose: 'reconnect' as const }]) {
    assert.throws(() => custody.open(changed,envelope), (e: unknown) => e instanceof KernelError && e.code === 'unavailable');
  }
  for (const field of ['nonce','ciphertext','tag'] as const) {
    const altered = { nonce: Buffer.from(envelope.nonce), ciphertext: Buffer.from(envelope.ciphertext), tag: Buffer.from(envelope.tag) };
    altered[field][0] ^= 1;
    assert.throws(() => custody.open(s,altered), (e: unknown) => e instanceof KernelError && e.code === 'unavailable');
  }
  assert.throws(() => secrets().open(s,envelope), (e: unknown) => e instanceof KernelError && e.code === 'unavailable');
  assert.equal(JSON.stringify(envelope).includes('fixture-key'),false);
  assert.throws(() => custody.seal(s,'\uD800'),(e: unknown) => e instanceof KernelError && e.code === 'invalid');
});

// Regression: same stable operation with a changed key or accepted primitive cannot retain its old result.
test('server HMAC binds exact intent, submitted key, consumer and operation', () => {
  const custody = secrets();
  const accepted = { context: { consumerId: 'synthetic-consumer' }, intent: { operationId: 'op',kind: 'create' as const,
    ownerRef: 'owner',profile: 'profile',displayName: 'Name',intentDigest: '' },apiKey: 'fixture-key' };
  const original = custody.digest(accepted);
  assert.equal(custody.digest({ ...accepted, intent: { ...accepted.intent } }),original);
  for (const changed of [{ ...accepted,apiKey: 'fixture-changed' },{ ...accepted,context: { consumerId: 'other' } },
    { ...accepted,intent: { ...accepted.intent,operationId: 'new' } },{ ...accepted,intent: { ...accepted.intent,ownerRef: 'other' } },
    { ...accepted,intent: { ...accepted.intent,profile: 'other' } },{ ...accepted,intent: { ...accepted.intent,displayName: 'name' } }]) {
    assert.notEqual(custody.digest(changed),original);
  }
});

// Regression: a lost POST ACK must use generation-specific GET, without implicit HTTP retry or bearer forwarding.
test('real local HTTP lost create ACK is uncertain and readback preserves native birth precision', async () => {
  const j = journal(), d = descriptor(j); let creates = 0; const paths: string[] = []; const authorizations: boolean[] = [];
  let received: Record<string, unknown> | undefined;
  const server = await local((req,res) => {
    paths.push(req.method + ' ' + req.url); authorizations.push(req.headers.authorization === 'Bearer ' + 'synthetic-control');
    if (req.method === 'POST') {
      creates++; const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => { received = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; req.socket.destroy(); });
    } else { res.setHeader('content-type','application/json'); res.end(JSON.stringify(nativeBody(d))); }
  });
  try {
    const native = client(server.origin);
    await assert.rejects(native.create(j,'Synthetic fixture','fixture-key'),code('unavailable'));
    const rows = await native.read(j);
    assert.equal(creates,1); assert.deepEqual(paths,['POST /private/native/v1/candidates','GET /private/native/v1/candidates/' + j.generation]);
    assert.equal(rows[0].nativeId,734); assert.equal(rows[0].createdAt,'2026-10-03T04:05:06.123456789+00:00');
    assert.equal(rows[0].nativePhysicalIdentity,j.generation); assert.equal(authorizations.every(Boolean),true);
    assert.ok(received); assert.deepEqual(Object.keys(received).sort(),['account_ref','api_key','generation','name','owner_ref','profile']);
    assert.equal(received.account_ref,j.accountRef); assert.equal(received.owner_ref,j.ownerRef);
  } finally { await server.close(); }
});

// Regression: redirect/error bodies could leak credentials or send them to a second origin; 401 cannot mean NoEffect.
test('redirect and 401 stay sanitized, uncertain and never followed', async () => {
  let escaped = 0, requests = 0;
  const target = await local((_req,res) => { escaped++; res.end('{}'); });
  const server = await local((_req,res) => { requests++; res.statusCode = requests === 1 ? 302 : 401;
    res.setHeader('location',target.origin); res.end('synthetic-private-error-body'); });
  try {
    const native = client(server.origin), j = journal();
    for (const expected of ['redirect','unavailable']) {
      await assert.rejects(native.create(j,'Fixture','fixture-key'),(e: unknown) => {
        assert.ok(e instanceof NativeFailure); assert.equal(e.code,expected); assert.equal(e.classification,'uncertain');
        assert.equal(e.message.includes('synthetic-private-error-body'),false); assert.equal('cause' in e,false); return true;
      });
    }
    assert.equal(requests,2); assert.equal(escaped,0);
  } finally { await server.close(); await target.close(); }
});

// Regression: streamed oversized/malformed native output and a stalled socket must not escape bounds/deadline or reflect a body.
test('HTTP readback enforces byte cap, JSON integrity and whole-request deadline', async () => {
  let calls = 0;
  const server = await local((_req,res) => { calls++;
    if (calls === 1) res.end('x'.repeat(513)); else if (calls === 2) res.end('synthetic-invalid-json');
  });
  try {
    const native = client(server.origin,{ bodyBytes: 512,deadlineMs: 100 }),j = journal();
    await assert.rejects(native.read(j),code('bounded'));
    await assert.rejects(native.read(j),code('invalid_readback'));
    await assert.rejects(native.read(j),code('deadline'));
    assert.equal(calls,3);
  } finally { await server.close(); }
});

// Regression: caller-selected external HTTP origin, admin route or cross-consumer credential use must never open a socket.
test('fixed private origin, candidate-only path and authenticated consumer binding fail closed', async () => {
  assert.throws(() => client('http://public.invalid'),KernelError);
  assert.throws(() => client('https://private.invalid/callback'),KernelError);
  assert.throws(() => client('https://private.invalid/admin'),KernelError);
  let calls = 0; const server = await local((_req,res) => { calls++; res.end('{}'); });
  try { await assert.rejects(client(server.origin).read({ ...journal(),consumerId: 'other' }),code('denied')); assert.equal(calls,0); }
  finally { await server.close(); }
});

// Regression: private descriptor validation must reject lossy numbers and malformed births without timestamp normalization.
test('private physical identity rejects imprecise numeric ID and preserves exact timestamp text', () => {
  const j = journal(),d = descriptor(j);
  assert.equal(physicalCandidate(d).createdAt,'2026-10-03T04:05:06.123456789+00:00');
  assert.throws(() => physicalCandidate({ ...d,nativeId: Number.MAX_SAFE_INTEGER + 1 }),KernelError);
  assert.throws(() => physicalCandidate({ ...d,createdAt: '2026-10-03T04:05:06.123456789012Z' }),KernelError);
  assert.throws(() => physicalCandidate({ ...d,createdAt: '2026-02-31T04:05:06.123456789Z' }),KernelError);
  assert.throws(() => physicalCandidate({ ...d,baseURL: 'https://secret@fixture.invalid' }),KernelError);
});

// Regression: JSON.parse rounds fractional native identity tokens to an accepted integer.
test('native HTTP readback validates original account_id tokens without rounding', async () => {
  const j = journal();
  const body = (token: string): string => `{"descriptor":{"account_id":${token},"generation":"${j.generation}",` +
    '"created_at":"2026-10-03T04:05:06.123456789+00:00","profile":"synthetic-profile",' +
    '"base_url":"https://fixture.invalid/v1","model":"fixture-model"},"name":"Disposable fixture",' +
    '"state":"inactive","group_free":true,"schedulable":false,"probes_enabled":false}';
  let response = '';
  const server = await local((_req,res) => res.end(response));
  try {
    const native = client(server.origin);
    for (const [token,expected] of [['734',734],['9007199254740991',9007199254740991]] as const) {
      response = body(token);
      const [row] = await native.read(j);
      assert.equal(row.nativeId,expected);
      assert.equal(row.createdAt,'2026-10-03T04:05:06.123456789+00:00');
    }
    for (const token of ['734.000000000000000001','733.999999999999999999',
      '9007199254740992','734.0','7.34e2','0','-734','"734"']) {
      response = body(token);
      await assert.rejects(native.read(j),code('invalid_readback'),token);
    }
    // Canonical escaped member names still denote the same field and enforce its raw token.
    response = body('734').replace('account_id','account_\\u0069d');
    assert.equal((await native.read(j))[0].nativeId,734);
    response = body('734.000000000000000001').replace('account_id','account_\\u0069d');
    await assert.rejects(native.read(j),code('invalid_readback'));
  } finally { await server.close(); }
});

// Regression: arrays, repeated/escaped identity members and non-inert flags could turn ambiguous native output into promotion proof.
test('existing private Go wire rejects ambiguous shape, duplicate identity and unsafe candidate flags', async () => {
  const j = journal(),body = nativeBody(descriptor(j));
  const valid = JSON.stringify(body);
  const variants = [JSON.stringify([body,body]),JSON.stringify([]),
    valid.replace('"account_id":734','"account_id":735,"account_id":734'),
    valid.replace('"generation":','"generati\\u006fn":"' + randomUUID() + '","generation":'),
    valid.replace('"group_free":true','"group_free":false'),valid.replace('"schedulable":false','"schedulable":true'),
    valid.replace('"probes_enabled":false','"probes_enabled":true'),valid.replace('"state":"inactive"','"state":"unknown"')];
  let calls = 0;
  const server = await local((_req,res) => res.end(variants[calls++]));
  try {
    const native = client(server.origin);
    for (const _variant of variants) await assert.rejects(native.read(j),code('invalid_readback'));
    assert.equal(calls,8);
  } finally { await server.close(); }
});

// Regression: cleanup could send DELETE/ID-only bodies, erase an active row or accept a malformed native erasure ACK.
test('candidate state and erasure use exact native descriptor names and precision', async () => {
  const j = journal(),d = descriptor(j),mapping = { ...j,descriptor: d };
  const observed: { method: string; path: string; body: unknown }[] = [];
  let state: 'active' | 'inactive' = 'active';
  const server = await local((req,res) => {
    const chunks: Buffer[] = [];
    req.on('data',chunk => chunks.push(chunk as Buffer)); req.on('end',() => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { state?: 'active' | 'inactive' };
      observed.push({ method: req.method!,path: req.url!,body });
      if (req.method === 'PUT') { state = body.state!; res.end(JSON.stringify(nativeBody(d,state))); }
      else res.end(JSON.stringify({ state: 'tombstoned',credentials_erased: false }));
    });
  });
  try {
    const native = client(server.origin);
    await native.setState(mapping,'inactive');
    await assert.rejects(native.erase(mapping),code('invalid_readback'));
    const exact = { account_id: 734,generation: j.generation,created_at: '2026-10-03T04:05:06.123456789+00:00',
      profile: 'synthetic-profile',base_url: 'https://fixture.invalid/v1',model: 'fixture-model' };
    assert.deepEqual(observed,[
      { method: 'PUT',path: '/private/native/v1/candidates/' + j.generation,body: { descriptor: exact,state: 'inactive' } },
      { method: 'POST',path: '/private/native/v1/candidates/' + j.generation + '/erase',body: { descriptor: exact } },
    ]);
  } finally { await server.close(); }
});

// Regression: malformed headers or an oversized key could exhaust the private HTTP boundary or expose native parser diagnostics.
test('actual HTTP header bound and ingress key bound fail with classified errors', async () => {
  let calls = 0;
  const server = await local((_req,res) => { calls++; res.setHeader('x-synthetic-large','x'.repeat(17_000)); res.end('{}'); });
  try {
    const native = client(server.origin),j = journal();
    await assert.rejects(native.read(j),code('unavailable'));
    await assert.rejects(native.create(j,'Fixture','x'.repeat(4097)),code('bounded'));
    assert.equal(calls,1);
  } finally { await server.close(); }
});


// Independent wire tests catch wrong protocol/descriptor/purpose acceptance.
for (const oauth of [false, true]) test('retained custody HTTP binds exact ' + (oauth ? 'OAuth' : 'API-key') + ' scope and rejects unknown peers', async () => {
  const source = journal();
  const j = { ...source, ...(oauth ? { profile: { ...codexOAuthProfile, qualificationRef: 'fixture-only' } } : {}) };
  const d = descriptor(j), mapping = { ...j, descriptor: d };
  const native = { account_id: d.nativeId, generation: d.generation, created_at: d.createdAt,
    profile: d.profile, base_url: d.baseURL, model: d.model };
  let reply: unknown = { contract: 'native-retained-custody/v1', generation: j.generation, native,
    credential_kinds: [oauth ? 'oauth' : 'api_key'], retention: { state: oauth ? 'inactive' : 'active', credential: 'retained' },
    proof: { authenticated: true }, ...(oauth ? { oauth_policy: { provider_validity: 'unasserted',
      expired_but_refreshable: 'eligible-by-existing-policy' } } : {}) };
  const valid = reply; let calls = 0; const received: unknown[] = [];
  const server = await local((req, res) => {
    calls++; assert.equal(req.headers.authorization, 'Bearer synthetic-control');
    assert.equal(req.method, oauth ? 'POST' : 'GET');
    assert.equal(req.url, oauth ? '/private/native/v1/oauth/connect/custody' : '/private/native/v1/candidates/' + j.generation + '/custody');
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { received.push(JSON.parse(Buffer.concat(chunks).toString())); res.end(JSON.stringify(reply)); });
  });
  try {
    const client = new NativeRetainedCustodyClient({ origin: server.origin, consumerId: j.consumerId, controlCredential: 'synthetic-control' });
    assert.deepEqual(await client.verify(mapping), { contract: 'native-retained-custody/v1', generation: j.generation,
      nativePhysicalIdentity: j.generation, credentialKinds: [oauth ? 'oauth' : 'api_key'] });
    assert.deepEqual(received[0], { contract: 'native-retained-custody/v1', owner_ref: j.ownerRef,
      account_ref: j.accountRef, descriptor: native, ...(oauth ? { operation: j.operationId, generation: j.generation } : {}) });
    for (const changed of [{ contract: 'unknown/v1' }, { generation: randomUUID() },
      { native: { ...native, account_id: d.nativeId + 1 } }, { proof: { authenticated: false } },
      { credential_kinds: [oauth ? 'api_key' : 'oauth'] }, { retention: { state: oauth ? 'inactive' : 'active', credential: 'erased' } },
      { retention: { state: oauth ? 'active' : 'inactive', credential: 'retained' } },
      { secret: 'must-not-escape' }]) {
      reply = { ...(valid as object), ...changed };
      await assert.rejects(client.verify(mapping), code('invalid_readback'));
    }
    reply = valid; const before = calls;
    await assert.rejects(client.verify({ ...mapping, consumerId: 'foreign-consumer' }), code('denied'));
    assert.equal(calls, before);
  } finally { await server.close(); }
});
