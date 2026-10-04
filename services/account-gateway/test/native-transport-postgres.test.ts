// Synthetic Go peer over real TCP + real disposable SQL. This suite does not
// qualify actual Go, provider protocol conversion, launcher, or RR assembly.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { PostgresKernel } from '../src/postgres.ts';
import { AccountManagement } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { NativeManagementClient } from '../src/native-client.ts';
import { createFacade, FacadeBearers } from '../src/facade.ts';
import { NativeAuthority } from '../src/native-authority.ts';
import { NativeHTTPTransport } from '../src/native-transport.ts';
import type { NativeDispatchProof, PrivateAdmission } from '../src/domain.ts';
import type { Descriptor, Receipt } from '../src/native-wire.ts';

let pool: pg.Pool;
// Each synthetic creation has its own native identity, as the native DB sequence does.
let nextNativeAccountId = 1;
before(async () => {
  const dsn = process.env.AG_NATIVE_BRIDGE_TEST_DSN, database = process.env.AG_NATIVE_BRIDGE_DISPOSABLE_DB;
  if (!dsn || !database || !/^ag_kernel_test_[a-z0-9_]+$/.test(database) || process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10')
    throw new Error('NOT_RUN: NEW disposable PG17.10 native bridge database required');
  let u: URL; try { u = new URL(dsn); } catch { throw new Error('NOT_RUN: invalid disposable designation'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) ||
      u.pathname !== '/' + database || u.search || u.hash) throw new Error('NOT_RUN: refusing remote or unspecified database');
  pool = new pg.Pool({ connectionString: dsn, max: 8, connectionTimeoutMillis: 5000 }); pool.on('error', () => undefined);
  try {
    const r = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
    assert.equal(r.db, database); assert.match(r.version, /^17\.10(?:$| )/);
    assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')")).rowCount, 0);
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort())
      await pool.query(await readFile(new URL(file, directory), 'utf8'));
  } catch (e) { if (e instanceof assert.AssertionError) throw e; throw new Error('NOT_RUN: disposable PostgreSQL setup unavailable'); }
});
after(async () => { await pool?.end(); });

const profile = { profile: 'synthetic-profile', baseURL: 'https://fixture.invalid/v1', model: 'fixture-model', qualificationRef: 'synthetic-only' };
const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const payload = Buffer.from('{"model":"fixture-model","stream":true,"store":false,"service_tier":"default","input":[{"n":9007199254740993,"v":1.2300,"s":"\\u0061"}]}');
const credentials = { executionCredential: 'test-fixture-literal-execution', cleanupCredential: 'test-fixture-literal-cleanup', callbackCredential: 'test-fixture-literal-callback' };
async function listen(s: Server): Promise<string> {
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const a = s.address(); assert.ok(a && typeof a === 'object'); return 'http://127.0.0.1:' + a.port;
}
async function stop(s: Server): Promise<void> { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
type Mode = 'complete' | 'unclosed' | 'closeFailed' | 'partial' | 'overflow' | 'noentry' | 'lost-admit-ack' | 'redirect' | 'held';
interface NativeInput { requestRef: string; worker: string; admission: PrivateAdmission; descriptor: Descriptor }

async function fixture(mode: Mode = 'complete') {
  const context = { consumerId: 'native-' + randomUUID() }, worker = randomUUID(), incarnation = randomUUID();
  const kernel = new PostgresKernel(pool), store = new PostgresManagementStore(pool, new IntentSecrets(randomBytes(32), randomBytes(32)));
  await kernel.heartbeat(context, worker);
  const operationId = randomUUID();
  const account = await kernel.beginAccount(context, { operationId, kind: 'create', intentDigest: 'synthetic-account',
    ownerRef: 'workspace-fixture', profile: profile.profile, displayName: 'Fixture' });
  assert.ok(account.accountRef);
  const candidate = await kernel.startCandidate(context, operationId, worker); assert.ok(candidate);
  const scope = { consumerId: context.consumerId, operationId, accountRef: account.accountRef, ownerRef: 'workspace-fixture', purpose: 'create' as const };
  const journal = await store.journal(scope, candidate.candidate, worker, profile);
  const physical = { generation: candidate.candidate, nativePhysicalIdentity: candidate.candidate, nativeId: nextNativeAccountId++,
    createdAt: '2026-10-03T04:05:06.123456789Z', profile: profile.profile, baseURL: profile.baseURL, model: profile.model };
  await store.saveMapping({ ...journal, descriptor: physical });
  await kernel.acknowledgeCandidate(context, operationId, worker, physical);
  const prepared = await kernel.prepare(context, { operationId: randomUUID(), intentDigest: 'synthetic-approval',
    invocationRef: 'invocation-' + randomUUID(), attemptRef: 'opaque-attempt', permittedAccounts: [account.accountRef],
    profile: profile.profile, policySubject: 'binding-fixture', policyRevision: 2, bindingRevision: 3,
    issuerEpoch: await kernel.issuer(context), deadline: new Date(Date.now() + 45_000), limits });
  assert.ok(prepared.executionRef);
  const saved = await kernel.savedExecution(context, prepared.executionRef);
  let callbackOrigin = '', posts = 0, entries = 0, permits = 0, ackCalls = 0;
  let resolveEntry: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { resolveEntry = resolve; });
  const raws: Buffer[] = [], records = new Map<string, Receipt>();
  const call = async (route: string, body: unknown, token = credentials.callbackCredential) => fetch(callbackOrigin + '/private/native/v1/' + route,
    { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  const peer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c as Uint8Array));
      const raw = Buffer.concat(chunks), action = req.url?.slice('/private/native/v1/transports'.length) ?? '';
      if (action === '') {
        posts++; assert.equal(req.headers.authorization, 'Bearer ' + credentials.executionCredential); raws.push(raw);
        if (mode === 'redirect') { res.writeHead(307, { location: '/private/native/v1/transports' }); res.end(); return; }
        const input = JSON.parse(raw.toString()) as NativeInput;
        const native = { originRef: 'protected-origin', engineIncarnation: incarnation, requestNonce: randomUUID(), generation: input.descriptor.generation };
        const admit = { consumerId: context.consumerId, ...input, native } as NativeInput & { payload?: unknown; consumerId: string; native: NativeDispatchProof['native'] };
        delete admit.payload;
        const response = await call('admit', admit); assert.equal(response.status, 200);
        const reply = await response.json() as { dispatch?: { closure: NativeDispatchProof }; leaseExpiresAt?: string; status: { effect: string } };
        const duplicate = await call('admit', admit); assert.equal(duplicate.status, 200);
        const readback = await duplicate.json() as Record<string, unknown>;
        assert.equal('dispatch' in readback, false); assert.equal('nativeDescriptor' in readback, false); assert.equal('leaseExpiresAt' in readback, false);
        if (!reply.dispatch) { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}'); return; }
        permits++;
        const p = reply.dispatch.closure;
        assert.ok(reply.leaseExpiresAt);
        const equivalent = reply.leaseExpiresAt.replace(/\.(\d{3})Z$/, (_, ms: string) => '.' + ms + '000000Z');
        const extension = reply.leaseExpiresAt.replace(/\.(\d{3})Z$/, (_, ms: string) => '.' + ms + '000001Z');
        assert.equal((await call('dispatch-proof', { consumerId: context.consumerId, proof: p, leaseExpiresAt: equivalent })).status, 200);
        assert.equal((await call('dispatch-proof', { consumerId: context.consumerId, proof: p, leaseExpiresAt: extension })).status, 403);
        const entered = !['noentry','lost-admit-ack'].includes(mode); if (entered) entries++;
        const r: Receipt = { consumerId: context.consumerId, executionRef: input.admission.executionRef, requestRef: input.requestRef,
          native, proof: p, phase: 'closed', effect: entered ? 'completed' : 'effect_unknown', sealed: true, acknowledged: false,
          lifetime: { entered, contextDone: !['unclosed','held'].includes(mode), forwardingReturned: mode !== 'held', bodyKnown: true,
            bodyClosed: !['closeFailed','held'].includes(mode), closeFailed: mode === 'closeFailed', completed: entered && !['partial','overflow','unclosed','closeFailed','held'].includes(mode), sealed: true } };
        if (['unclosed','closeFailed','held'].includes(mode)) r.phase = 'entered';
        if (!r.lifetime.completed) r.effect = 'effect_unknown';
        if (mode === 'lost-admit-ack') delete r.proof;
        records.set(input.requestRef, r);
        if (!entered) {
          // First receipt may precede ContextDone. Same-proof readback supplies
          // later positive closure; cached claim status remains dispatch_started.
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...r, ...(mode === 'lost-admit-ack' ? { proof: undefined } : {}),
            phase: 'admitted', lifetime: { ...r.lifetime, contextDone: false }, status: reply.status })); return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-gateway-request-ref': input.requestRef });
        res.write('data: fixture\n\n');
        resolveEntry();
        if (mode === 'held') return;
        if (mode === 'partial') { res.flushHeaders(); setTimeout(() => res.destroy(), 10); return; }
        if (mode === 'overflow') res.write(Buffer.alloc(limits.outputBytes + 1, 0x20));
        res.end(); return;
      }
      const input = JSON.parse(raw.toString()) as { proof: NativeDispatchProof; cleanup?: unknown }, p = input.proof;
      const delegate = !action.endsWith('-owner');
      assert.equal(req.headers.authorization, 'Bearer ' + (delegate ? credentials.cleanupCredential : credentials.executionCredential));
      const r = records.get(p.requestRef); assert.ok(r);
      const authorized = await call(delegate ? 'cleanup-authority' : 'owner-closure-authority',
        { consumerId: context.consumerId, proof: p, ...(delegate ? { cleanup: input.cleanup } : {}) });
      if (authorized.status !== 200) { res.writeHead(403); res.end('{}'); return; }
      // Same original proof can attach to a sealed lost-ACK reservation. This
      // synthetic peer never changes its entry count or re-admits on attachment.
      if (!r.proof) { assert.equal(p.worker, worker); assert.deepEqual(p.native, r.native); r.proof = p; }
      if (action.startsWith('/ack')) {
        ackCalls++;
        const ack = await call('closure-ack', { consumerId: context.consumerId, proof: p, receipt: r, ...(delegate ? { cleanup: input.cleanup } : {}) });
        if (ack.status !== 200) { res.writeHead(403); res.end('{}'); return; }
        r.acknowledged = true;
      }
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...r, proof: p }));
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end('{}'); });
  });
  const nativeOrigin = await listen(peer);
  const authority = new NativeAuthority({ kernel, store, config: { origin: nativeOrigin,
    enrollment: { originRef: 'protected-origin', engineIncarnation: incarnation, worker, qualificationRef: profile.qualificationRef },
    consumers: [{ consumerId: context.consumerId, ...credentials }], profiles: [{ ...profile, requestBytes: 4096, outputBytes: 4096, tokens: 100, providerTokenUpperBound: 1000 }],
    timeoutMs: 1000, closureWaitMs: 50 } });
  const callbacks = authority.createServer(); callbackOrigin = await listen(callbacks);
  const enrollment = await call('enrollment', { originRef: 'protected-origin', engineIncarnation: incarnation, qualificationRef: profile.qualificationRef });
  assert.equal(enrollment.status, 200); assert.deepEqual(await enrollment.json(), { ok: true });
  const transport = new NativeHTTPTransport(authority);
  const management = new AccountManagement({ kernel, store, worker, custody: new IntentSecrets(randomBytes(32), randomBytes(32)), profiles: [profile],
    native: new NativeManagementClient({ origin: nativeOrigin, consumerId: context.consumerId, controlCredential: 'test-fixture-literal' }),
    proof: { async verify() { return true; } } });
  const bearer = 'test-fixture-literal-facade';
  const facade = createFacade({ kernel, management, store, transport, enrollment: authority.configuration.enrollment,
    bearers: new FacadeBearers([{ role: 'execution', consumerId: context.consumerId, token: bearer, saved }]),
    profiles: [{ dto: { profileId: profile.profile, protocol: 'openai-responses', modelIds: [profile.model], authKinds: ['api_key'] }, maxOutputTokens: 1000 }],
    intentHmacKey: randomBytes(32), timeoutMs: 5000 });
  const origin = await listen(facade);
  const { executionRef: _ref, issuerEpoch: _issuer, ...publicAdmission } = saved.admission;
  const request = async (requestId = randomUUID(), body: Uint8Array = payload, signal?: AbortSignal) => {
    const response = await fetch(origin + '/v1/executions/' + saved.admission.executionRef + '/requests', {
      method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', accept: 'text/event-stream',
        'x-gateway-request-id': requestId, 'x-gateway-admission': JSON.stringify(publicAdmission) }, body: Buffer.from(body), signal });
    let failed = response.status !== 200 && response.status !== 202;
    try { await response.arrayBuffer(); } catch { failed = true; }
    return { requestId, response, failed };
  };
  const occupied = async (requestId: string) => (await pool.query('SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND id=$2', [context.consumerId, requestId])).rows[0].transport_occupied as boolean;
  return { context, kernel, store, worker, saved, authority, transport, call, callbackOrigin, records, raws, request, occupied, entered,
    stats: () => ({ posts, entries, permits, ackCalls }), stop: async () => { await stop(facade); await stop(callbacks); await stop(peer); } };
}

test('synthetic TCP/SQL: positive owner closure releases concurrency1 for two requests in the SAME OPEN execution', async () => {
  const f = await fixture(); try {
    for (let i = 0; i < 2; i++) {
      const r = await f.request(); assert.equal(r.failed, false);
      assert.equal((await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId)).effect, 'completed');
      assert.equal(await f.occupied(r.requestId), false);
      assert.equal((await f.kernel.execution(f.context, f.saved.admission.executionRef)).state, 'open');
    }
    assert.deepEqual(f.stats(), { posts: 2, entries: 2, permits: 2, ackCalls: 2 });
    assert.equal((await pool.query('SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [f.context.consumerId, f.saved.admission.executionRef])).rows[0].request_count, 2);
    for (const raw of f.raws) {
      const prefix = Buffer.from(',"payload":'), start = raw.indexOf(prefix) + prefix.length;
      assert.deepEqual(raw.subarray(start, raw.length - 1), payload);
      assert.equal((JSON.parse(raw.toString()) as NativeInput).descriptor.created_at, '2026-10-03T04:05:06.123456789Z');
    }
  } finally { await f.stop(); }
});
test('synthetic TCP/SQL: EOF, CloseFailed, partial and output cap retain occupancy and fence fresh request IDs', async () => {
  for (const mode of ['unclosed','closeFailed','partial','overflow'] as const) {
    const f = await fixture(mode); try {
      const r = await f.request();
      assert.equal((await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId)).effect, 'effect_unknown');
      if (mode === 'unclosed' || mode === 'closeFailed') assert.equal(await f.occupied(r.requestId), true);
      const again = await f.request(); assert.equal(again.failed, true); assert.equal(f.stats().posts, 1); assert.equal(f.stats().entries, 1);
    } finally { await f.stop(); }
  }
});
test('synthetic TCP/SQL: exact positive no-entry and sealed lost admit ACK spend one claim, never enter, then close independently', async () => {
  for (const mode of ['noentry','lost-admit-ack'] as const) {
    const f = await fixture(mode); try {
      const r = await f.request(); assert.equal(r.failed, false);
      assert.equal((await f.kernel.request(f.context, f.saved.admission.executionRef, r.requestId)).effect, 'rejected_before_dispatch');
      assert.equal(await f.occupied(r.requestId), false);
      assert.equal(f.stats().entries, 0); assert.equal(f.stats().permits, 1); assert.equal(f.stats().posts, 1);
      await f.request(r.requestId); assert.equal(f.stats().posts, 1);
      assert.equal((await pool.query('SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [f.context.consumerId, f.saved.admission.executionRef])).rows[0].request_count, 1);
    } finally { await f.stop(); }
  }
});
test('synthetic TCP/SQL: expired original owner may ACK immutable completed proof but cannot dispatch; foreign authority denies', async () => {
  const f = await fixture(); try {
    const r = await f.request(), native = f.records.get(r.requestId); assert.ok(native?.proof); const p = native.proof;
    await pool.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2", [f.context.consumerId, f.worker]);
    assert.equal((await f.call('owner-closure-authority', { consumerId: f.context.consumerId, proof: p })).status, 200);
    assert.equal((await f.call('dispatch-proof', { consumerId: f.context.consumerId, proof: p, leaseExpiresAt: new Date(Date.now() + 100).toISOString() })).status, 403);
    const ack = await f.call('closure-ack', { consumerId: f.context.consumerId, proof: p, receipt: native });
    assert.equal(ack.status, 200); assert.deepEqual(await ack.json(), { ok: true });
    for (const changed of [{ ...p, token: randomUUID() }, { ...p, worker: randomUUID() },
      { ...p, native: { ...p.native, engineIncarnation: randomUUID() } }])
      assert.equal((await f.call('owner-closure-authority', { consumerId: f.context.consumerId, proof: changed })).status, 403);
    assert.equal((await f.call('owner-closure-authority', { consumerId: 'foreign-consumer', proof: p })).status, 403);
    assert.equal((await f.kernel.request(f.context, p.executionRef, p.requestRef)).effect, 'completed');
  } finally { await f.stop(); }
});
test('synthetic TCP/SQL: delegate needs the actual current cleanup row/token/execution scope; no guessed expiry', async () => {
  const f = await fixture('unclosed'); try {
    const r = await f.request(), p = await f.kernel.requestProof(f.context, f.saved.admission.executionRef, r.requestId); assert.ok(p);
    const job = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(job && job.scope.kind === 'execution');
    const leaseExpiresAt = await f.kernel.currentCleanupLease(f.context, job.cleanupRef, f.worker, job.token);
    const c = { cleanupRef: job.cleanupRef, worker: f.worker, token: job.token, leaseExpiresAt };
    assert.equal((await f.call('cleanup-authority', { consumerId: f.context.consumerId, proof: p, cleanup: c })).status, 200);
    for (const changed of [{ ...c, token: randomUUID() }, { ...c, cleanupRef: randomUUID() },
      { ...c, leaseExpiresAt: new Date(Date.now() + 10_000).toISOString() }])
      assert.equal((await f.call('cleanup-authority', { consumerId: f.context.consumerId, proof: p, cleanup: changed })).status, 403);
    const other = await f.kernel.prepare(f.context, { operationId: randomUUID(), intentDigest: 'other-fixture', invocationRef: randomUUID(),
      attemptRef: 'other-attempt', permittedAccounts: [f.saved.admission.accountRef], profile: profile.profile,
      policySubject: 'binding-fixture', policyRevision: 2, bindingRevision: 3, issuerEpoch: f.saved.admission.issuerEpoch,
      deadline: new Date(Date.now() + 10_000), limits });
    assert.ok(other.executionRef); await f.kernel.close(f.context, randomUUID(), other.executionRef);
    const otherJob = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(otherJob && otherJob.scope.kind === 'execution');
    assert.equal(otherJob.scope.executionRef, other.executionRef);
    const otherLease = { cleanupRef: otherJob.cleanupRef, worker: f.worker, token: otherJob.token,
      leaseExpiresAt: await f.kernel.currentCleanupLease(f.context, otherJob.cleanupRef, f.worker, otherJob.token) };
    assert.equal((await f.call('cleanup-authority', { consumerId: f.context.consumerId, proof: p, cleanup: otherLease })).status, 403);
    const receipt = f.records.get(r.requestId); assert.ok(receipt);
    assert.equal((await f.call('closure-ack', { consumerId: f.context.consumerId, proof: p, cleanup: c, receipt })).status, 403);
    await pool.query("UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2", [f.context.consumerId, job.cleanupRef]);
    assert.equal((await f.call('cleanup-authority', { consumerId: f.context.consumerId, proof: p, cleanup: c })).status, 403);
    assert.equal(await f.occupied(r.requestId), true);
  } finally { await f.stop(); }
});
test('synthetic TCP/SQL: control HTTP rejects duplicate headers, aliases, duplicates, query, body cap and forged enrollment safely', async () => {
  const f = await fixture(); try {
    const endpoint = new URL(f.callbackOrigin);
    async function raw(headers: string[], body = '{}', route = '/private/native/v1/enrollment'): Promise<string> {
      return new Promise((resolve, reject) => {
        const s = connect({ host: '127.0.0.1', port: Number(endpoint.port) }), chunks: Buffer[] = [];
        s.setTimeout(3000, () => { s.destroy(); reject(new Error('fixture timeout')); }); s.on('error', () => resolve(Buffer.concat(chunks).toString()));
        s.on('data', b => chunks.push(b)); s.once('end', () => resolve(Buffer.concat(chunks).toString()));
        s.once('connect', () => s.write('POST ' + route + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n' + headers.join('\r\n') + '\r\n\r\n' + body));
      });
    }
    const auth = 'Authorization: Bearer ' + credentials.callbackCredential, type = 'Content-Type: application/json';
    for (const headers of [[type], [auth,auth,type], [auth,type,type], [auth,type,'Content-Encoding: identity']]) {
      const r = await raw(headers); assert.match(r, /HTTP\/1.1 403/); assert.equal(r.includes(credentials.callbackCredential), false);
    }
    for (const body of ['{"originRef":"x","originRef":"y"}', '{"OriginRef":"x"}', '{}', ' '.repeat(32_769)]) {
      const r = await raw([auth,type], body); assert.ok(!r.includes('HTTP/1.1 200'));
    }
    assert.match(await raw([auth,type], '{}', '/private/native/v1/enrollment?x=1'), /HTTP\/1.1 403/);
    assert.equal((await f.call('enrollment', { originRef: 'other', engineIncarnation: randomUUID(), qualificationRef: profile.qualificationRef })).status, 403);
    assert.equal(f.stats().posts, 0);
  } finally { await f.stop(); }
});
test('synthetic TCP/SQL: redirects do not replay inference, and uncertainty fences the original execution', async () => {
  const f = await fixture('redirect'); try {
    await f.request(); assert.equal(f.stats().posts, 1); assert.equal(f.stats().entries, 0);
    assert.equal((await f.kernel.execution(f.context, f.saved.admission.executionRef)).state, 'closed');
    const again = await f.request(); assert.equal(again.failed, true); assert.equal(f.stats().posts, 1);
  } finally { await f.stop(); }
});
test('synthetic TCP/SQL: the complete association rejects each tuple/cap, nanosecond birth, nonce and issuer substitution', async () => {
  const f = await fixture(); try {
    const r = await f.request(), original = JSON.parse(f.raws[0].toString()) as NativeInput, p = f.records.get(r.requestId)?.proof; assert.ok(p);
    const { requestRef, worker, admission, descriptor } = original;
    const tuple = { consumerId: f.context.consumerId, requestRef, worker, admission, descriptor, native: p.native };
    const variants: Partial<PrivateAdmission>[] = [{ executionRef: randomUUID() }, { issuerEpoch: randomUUID() },
      { invocationRef: 'other' }, { attemptRef: 'other' }, { accountRef: randomUUID() }, { authorizationEpoch: 99 },
      { subjectRef: 'other' }, { policyRevision: 99 }, { bindingRevision: 99 }, { profileId: 'other' },
      { expiresAt: admission.expiresAt.replace(/\.(\d{3})Z$/, (_, ms: string) => '.' + ms + '000001Z') }];
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) variants.push({ limits: { ...limits, [key]: limits[key] + 1 } });
    for (const variant of variants) assert.equal((await f.call('admit', { ...tuple, admission: { ...admission, ...variant } })).status, 403);
    for (const descriptorPatch of [{ account_id: descriptor.account_id + 1 }, { generation: randomUUID() }, { created_at: '2026-10-03T04:05:06.123456788Z' }])
      assert.equal((await f.call('admit', { ...tuple, descriptor: { ...descriptor, ...descriptorPatch } })).status, 403);
    assert.equal((await f.call('admit', { ...tuple, native: { ...p.native, requestNonce: randomUUID() } })).status, 403);
    assert.equal(f.stats().permits, 1); assert.equal(f.stats().entries, 1);
    assert.equal((await pool.query('SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [f.context.consumerId, admission.executionRef])).rows[0].request_count, 1);
  } finally { await f.stop(); }
});
test('synthetic TCP/SQL: client abort fences the original attempt and cannot certify held native body closure', async () => {
  const f = await fixture('held'); try {
    const controller = new AbortController(), id = randomUUID();
    const result = f.request(id, payload, controller.signal).catch(() => undefined);
    await f.entered; controller.abort(); await result;
    for (let n = 0; n < 50 && (await f.kernel.request(f.context, f.saved.admission.executionRef, id)).effect !== 'effect_unknown'; n++)
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal((await f.kernel.request(f.context, f.saved.admission.executionRef, id)).effect, 'effect_unknown');
    assert.equal(await f.occupied(id), true); await f.request(); assert.equal(f.stats().entries, 1); assert.equal(f.stats().posts, 1);
  } finally { await f.stop(); }
});
