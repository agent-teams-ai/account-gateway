import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IntentSecrets } from '../src/management-store.ts';
import { NativeFailure, NativeManagementClient } from '../src/native-client.ts';
import { physicalCandidate } from '../src/management.ts';
import type { CandidateJournal, CandidateScope, PhysicalCandidate } from '../src/management.ts';
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
