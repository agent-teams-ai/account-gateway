import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as c from '@agent-teams/account-gateway/contracts';
import { createManagementClient, createExecutionClient, GatewayError } from '@agent-teams/account-gateway/http';
import { createFacade, FacadeBearers, cancelFacadeTransport } from '../src/facade.ts';
import type { FacadeOptions, ManagementBearer, NativeCallback, NativePermit, NativeTransport } from '../src/facade.ts';
import { PostgresKernel } from '../src/postgres.ts';
import { AccountManagement } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { NativeManagementClient } from '../src/native-client.ts';
import type { NativeDispatchProof } from '../src/domain.ts';

let pool: pg.Pool;
before(async () => {
  const dsn = process.env.AG_FACADE_TEST_DSN, database = process.env.AG_FACADE_DISPOSABLE_DB;
  if (!dsn || !database || !/^ag_kernel_test_[a-z0-9_]+$/.test(database) || process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10')
    throw new Error('NOT_RUN: explicit NEW disposable PG17.10 facade database required');
  let url: URL;
  try { url = new URL(dsn); } catch { throw new Error('NOT_RUN: invalid disposable designation'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' + database || url.search || url.hash)
    throw new Error('NOT_RUN: refusing remote or unspecified database');
  pool = new pg.Pool({ connectionString: dsn, max: 6, connectionTimeoutMillis: 5000 }); pool.on('error', () => undefined);
  try {
    const version = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
    assert.equal(version.db, database); assert.match(version.version, /^17\.10(?:$| )/);
    assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')")).rowCount, 0, 'requires empty disposable database');
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()) await pool.query(await readFile(new URL(file, directory), 'utf8'));
  } catch (error) { if (error instanceof assert.AssertionError) throw error; throw new Error('NOT_RUN: disposable PostgreSQL setup unavailable; vendor details withheld'); }
});
after(async () => { await pool?.end(); });
let nextNativeId = 0;
const profile = { profile: 'synthetic-profile', baseURL: 'https://fixture.invalid/v1', model: 'fixture-model', qualificationRef: 'synthetic-only' };
const safeProfile: c.Profile = { profileId: profile.profile, protocol: 'openai-responses', modelIds: [profile.model], authKinds: ['api_key'] };
const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const nativeBytes = () => Buffer.from(JSON.stringify({ model: profile.model, stream: true, store: false, service_tier: 'default', input: 'synthetic fixture' }));
const denied = (effect?: string) => (error: unknown): boolean => error instanceof GatewayError && error.code === 'safe_error' && (!effect || error.effect === effect);
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
async function stop(server: ReturnType<typeof createServer>): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

// Explicit synthetic native peer, not Go/provider evidence. Real management
// HTTP -> encrypted custody/mapping SQL and real kernel claims are exercised.
async function fixture(mode: 'normal' | 'lost_ack' | 'overflow' | 'held' | 'missing' = 'normal') {
  const context = { consumerId: 'facade-' + randomUUID() }, kernel = new PostgresKernel(pool);
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32)), store = new PostgresManagementStore(pool, custody);
  const worker = randomUUID(), incarnation = randomUUID(), managementToken = 'fixture-management-' + randomUUID(), executionToken = 'fixture-execution-' + randomUUID();
  await kernel.heartbeat(context, worker);
  let creates = 0, calls = 0, entries = 0, cancelled = 0;
  let last: { callback: NativeCallback; proof: NativeDispatchProof; permit: NativePermit } | undefined;
  const raws: Uint8Array[] = [], nativeRows = new Map<string, { descriptor: object; state: string }>();
  const native = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      const generation = req.url?.split('/')[5] ?? '';
      if (req.method === 'POST' && req.url === '/private/native/v1/candidates') {
        creates++;
        const born = String(input.generation);
        nativeRows.set(born, { descriptor: { account_id: ++nextNativeId, generation: born, created_at: '2026-10-03T04:05:06.123456789Z',
          profile: profile.profile, base_url: profile.baseURL, model: profile.model }, state: 'inactive' });
        res.end('{}'); return;
      }
      const row = nativeRows.get(generation);
      if (!row) { res.statusCode = 404; res.end('{}'); return; }
      if (req.method === 'PUT') row.state = String(input.state);
      res.end(JSON.stringify({ ...row, name: 'Fixture', group_free: true, schedulable: false, probes_enabled: false }));
    })().catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  const nativeOrigin = await listen(native);
  const management = new AccountManagement({ kernel, store, custody, worker, profiles: [profile], proof: { async verify() { return true; } },
    native: new NativeManagementClient({ origin: nativeOrigin, consumerId: context.consumerId, controlCredential: 'synthetic-control' }) });
  let managementGrant: ManagementBearer = { role: 'management', token: managementToken, consumerId: context.consumerId, ownerRefs: ['workspace-fixture'],
    preparation: { accountRefs: [], subjectRef: 'binding-fixture', policyRevision: 2, bindingRevision: 3, profileId: profile.profile, limits, maxRunMs: 60_000 } };
  const bearers = new FacadeBearers([managementGrant]);
  const transport: NativeTransport = { async request(input) {
    calls++; raws.push(new Uint8Array(input.body));
    const nonce = randomUUID();
    const claims = await Promise.all([input.callback.admit(nonce), input.callback.admit(nonce)]);
    const permits = claims.filter(p => p.claim.dispatch); assert.equal(permits.length <= 1, true);
    const permit = permits[0]; if (!permit?.claim.dispatch) return { kind: 'status' };
    const proof = permit.claim.dispatch.closure; last = { callback: input.callback, proof, permit };
    if (mode === 'lost_ack') throw new Error('fixture-vendor-private-body fixture-key-private');
    entries++;
    await input.callback.effect(proof, 'response_started');
    return { kind: 'stream', async cancel() { cancelled++; }, body: (async function* () {
      if (mode === 'overflow') { yield Buffer.from('data: prefix\n\n'); await delay(25); yield new Uint8Array(limits.outputBytes + 1); return; }
      yield Buffer.from('data: synthetic-fixture\n\n');
      if (mode === 'held') {
        await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); }); return;
      }
      await input.callback.effect(proof, 'completed');
      // No closure inference from yielded output or the TS socket. Tests invoke
      // the exact synthetic native teardown acknowledgement separately.
    })() };
  }, async cancel() { cancelled++; } };
  const options: FacadeOptions = { kernel, management, store, bearers, profiles: [{ dto: safeProfile, maxOutputTokens: 1000 }],
    intentHmacKey: randomBytes(32), enrollment: mode === 'missing' ? undefined : { originRef: 'synthetic-origin', engineIncarnation: incarnation, worker }, transport: mode === 'missing' ? undefined : transport,
    timeoutMs: 5000, bufferBytes: 4096 };
  const server = createFacade(options);
  const origin = await listen(server), client = createManagementClient({ role: 'management', origin, token: managementToken });
  try {
  const created = await client.connect({ operationId: randomUUID(), ownerRef: 'workspace-fixture', profileId: profile.profile, displayName: 'Fixture', credential: { kind: 'api_key', value: 'fixture-key-private' } });
  assert.equal(created.state, 'applied'); assert.ok(created.state === 'applied' && created.result?.kind === 'account');
  const accountRef = created.result.accountRef;
  managementGrant = { ...managementGrant, preparation: { ...managementGrant.preparation, accountRefs: [accountRef] } }; bearers.replace([managementGrant]);
  const preparedInput: c.Prepare = { operationId: randomUUID(), invocationRef: 'invocation-' + randomUUID(), attemptRef: 'attempt-fixture', accountRefs: [accountRef],
    subjectRef: 'binding-fixture', policyRevision: 2, bindingRevision: 3, profileId: profile.profile, limits, deadline: new Date(Date.now() + 45_000).toISOString() };
  const prepared = await client.prepare(preparedInput);
  assert.ok(prepared.state === 'applied' && prepared.result?.kind === 'execution');
  const executionRef = prepared.result.executionRef, saved = await kernel.savedExecution(context, executionRef);
  const executionGrant = { role: 'execution' as const, token: executionToken, consumerId: context.consumerId, saved };
  bearers.replace([managementGrant, executionGrant]);
  const execution = createExecutionClient({ role: 'execution', origin, token: executionToken, bufferBytes: 4096 });
  const { executionRef: _ref, issuerEpoch: _issuer, ...admission } = saved.admission;
  const request = (requestId = randomUUID()) => ({ requestId, admission, body: nativeBytes() });
  const raw = async (path: string, method = 'GET', payload?: unknown, token = managementToken, headers: Record<string, string> = {}) => fetch(origin + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { context, kernel, store, worker, bearers, managementGrant, executionGrant, server, origin, client, execution, created, accountRef, executionRef, saved, admission, prepared, preparedInput,
    request, raw, options, stats: () => ({ creates, calls, entries, cancelled }), last: () => { assert.ok(last); return last; }, raws,
    stop: async () => { await stop(server); await stop(native); } };
  } catch (error) {
    await stop(server); await stop(native);
    throw error;
  }
}
async function consume(result: Awaited<ReturnType<ReturnType<typeof createExecutionClient>['request']>>): Promise<void> {
  if (result.kind === 'stream') { const reader = result.body.getReader(); for (;;) { if ((await reader.read()).done) return; } }
}

test('exported SDK management routes persist duplicate mutation/readback and safe metadata', async () => {
  const f = await fixture(); try {
    assert.deepEqual(await f.client.profiles(), { profiles: [safeProfile] });
    assert.equal((await f.client.list({ ownerRef: 'workspace-fixture' })).accounts.length, 1);
    const a = await f.client.get(f.accountRef), rename = { operationId: randomUUID(), expectedMetadataRevision: a.metadataRevision, displayName: 'Renamed' };
    const renamed = await f.client.rename(f.accountRef, rename); assert.deepEqual(await f.client.rename(f.accountRef, rename), renamed);
    assert.deepEqual(await f.client.operation(rename.operationId), renamed);
    assert.deepEqual(await f.client.prepare(f.preparedInput), f.prepared);
    assert.deepEqual(await f.client.operation(f.preparedInput.operationId), f.prepared);
    const current = await f.client.get(f.accountRef);
    const reconnected = await f.client.reconnect(f.accountRef, { operationId: randomUUID(), expectedMetadataRevision: current.metadataRevision, credential: { kind: 'api_key', value: 'fixture-replacement-key-private' } });
    assert.ok(reconnected.state === 'applied' && reconnected.result?.kind === 'account'); assert.equal(reconnected.result.authorizationEpoch, current.authorizationEpoch + 1);
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied()); assert.equal(f.stats().calls, 0);
    const disabled = await f.client.disable(f.accountRef, { operationId: randomUUID(), expectedMetadataRevision: reconnected.result.metadataRevision });
    assert.equal(disabled.state, 'applied'); assert.equal((await f.client.get(f.accountRef)).state, 'disabled');
    assert.equal(JSON.stringify([a, renamed, reconnected, disabled]).includes('fixture-key-private'), false);
  } finally { await f.stop(); }
});
test('derived roles, immutable consumer scope and rotation deny unrelated management/operation/execution authority', async () => {
  const f = await fixture(); try {
    const asManagement = createManagementClient({ role: 'management', origin: f.origin, token: f.executionGrant.token });
    await assert.rejects(asManagement.get(f.accountRef), denied()); await assert.rejects(asManagement.profiles(), denied());
    await assert.rejects(f.execution.operation(f.created.operationRef), denied());
    await assert.rejects(f.execution.status(randomUUID(), 'unrelated'), denied());
    const otherToken = 'fixture-other-consumer-' + randomUUID();
    f.bearers.replace([f.managementGrant, f.executionGrant, { ...f.managementGrant, token: otherToken, consumerId: 'other-' + randomUUID() }]);
    const other = createManagementClient({ role: 'management', origin: f.origin, token: otherToken }); await assert.rejects(other.get(f.accountRef), denied());
    f.bearers.replace([f.managementGrant]); await assert.rejects(f.execution.request(f.executionRef, f.request()), denied());
    assert.equal(f.stats().calls, 0);
  } finally { await f.stop(); }
});
test('schemas, OAuth rejection and server preparation policy reject malformed or widened ingress without custody mutation', async () => {
  const f = await fixture(); try {
    for (const patch of [{ subjectRef: 'other-binding' }, { policyRevision: 3 }, { bindingRevision: 4 }, { profileId: 'other-profile' },
      { accountRefs: [randomUUID()] }, { limits: { ...limits, tokens: 101 } }, { deadline: new Date(Date.now() + 120_000).toISOString() }]) {
      await assert.rejects(f.client.prepare({ ...f.preparedInput, operationId: randomUUID(), invocationRef: randomUUID(), ...patch }), denied('not_dispatched'));
    }
    await assert.rejects(f.client.connect({ operationId: randomUUID(), ownerRef: 'workspace-fixture', profileId: profile.profile, displayName: 'OAuth',
      credential: { kind: 'oauth', accessToken: 'test-fixture-literal', refreshToken: 'test-fixture-literal', expiresAt: new Date(Date.now() + 60_000).toISOString() } }), denied('not_dispatched'));
    const result = await f.raw('/v1/accounts', 'POST', { operationId: randomUUID(), ownerRef: 'workspace-fixture', profileId: profile.profile, displayName: 'Bad', credential: { kind: 'api_key', value: 'fixture-key-private' }, consumerId: 'caller' });
    assert.equal(result.status, 400); c.safeError.parse(await result.json()); assert.equal(f.stats().creates, 1);
  } finally { await f.stop(); }
});
test('all saved admission authority families and individual limits mismatch before native reservation', async () => {
  const f = await fixture(); try {
    const variants: Partial<c.Admission>[] = [{ invocationRef: 'other' }, { attemptRef: 'other' }, { accountRef: randomUUID() }, { authorizationEpoch: 99 },
      { subjectRef: 'other' }, { policyRevision: 99 }, { bindingRevision: 99 }, { profileId: 'other' }, { expiresAt: new Date(Date.now() + 1000).toISOString() }];
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) variants.push({ limits: { ...limits, [key]: limits[key] + 1 } });
    for (const variant of variants) await assert.rejects(f.execution.request(f.executionRef, { ...f.request(), admission: { ...f.admission, ...variant } }), denied('not_dispatched'));
    for (const patch of [{ generation: randomUUID() }, { admission: { ...f.saved.admission, issuerEpoch: randomUUID() } }]) {
      f.bearers.replace([f.managementGrant, { ...f.executionGrant, saved: { ...f.saved, ...patch } }]);
      await assert.rejects(f.execution.request(f.executionRef, f.request()), denied('not_dispatched'));
    }
    assert.equal(f.stats().calls, 0); assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1', [f.context.consumerId])).rows[0].n, 0);
  } finally { await f.stop(); }
});
test('body overcap and unsafe decoded native payload reject before callback; bytes otherwise stay exact', async () => {
  const f = await fixture(); try {
    for (const raw of [Buffer.alloc(limits.requestBytes + 1, 0x20), Buffer.from('{"model":"fixture-model","\\u006dodel":"fixture-model"}'),
      Buffer.from(JSON.stringify({ model: profile.model, stream: true, store: true, service_tier: 'default' }))]) {
      const response = await fetch(f.origin + '/v1/executions/' + f.executionRef + '/requests', { method: 'POST', headers: { authorization: 'Bearer ' + f.executionGrant.token,
        accept: 'text/event-stream', 'content-type': 'application/json', 'x-gateway-request-id': randomUUID(), 'x-gateway-admission': JSON.stringify(f.admission) }, body: raw });
      assert.equal(response.status, 400); c.safeError.parse(await response.json());
    }
    assert.equal(f.stats().calls, 0);
    const request = f.request(); await consume(await f.execution.request(f.executionRef, request)); assert.deepEqual(f.raws[0], new Uint8Array(request.body));
  } finally { await f.stop(); }
});
test('concurrent duplicate SDK POST and native callbacks return one SQL permit and one synthetic entry', async () => {
  const f = await fixture(); try {
    const request = f.request(); const results = await Promise.all([f.execution.request(f.executionRef, request), f.execution.request(f.executionRef, request)]);
    await Promise.all(results.map(consume)); assert.equal(f.stats().entries, 1);
    assert.equal(results.filter(r => r.kind === 'status').length, 1);
    assert.equal((await f.execution.status(f.executionRef, request.requestId)).effect, 'completed');
    const last = f.last(); assert.ok(last.permit.permitExpiresAt && last.permit.physical);
    assert.equal(last.permit.physical.createdAt, '2026-10-03T04:05:06.123456789Z');
    assert.ok(Date.parse(last.permit.permitExpiresAt) <= Date.parse(await f.kernel.currentWorkerLease(f.context, f.worker)));
    assert.ok(Date.parse(last.permit.permitExpiresAt) <= Date.parse(f.saved.admission.expiresAt));
    assert.equal((await pool.query('SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [f.context.consumerId, f.executionRef])).rows[0].request_count, 1);
    // Output and TS socket closure did not release native occupancy.
    assert.equal((await pool.query('SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND id=$2', [f.context.consumerId, request.requestId])).rows[0].transport_occupied, true);
    await assert.rejects(last.callback.closed({ ...last.proof, token: randomUUID() }));
    await last.callback.closed(last.proof); assert.equal((await f.execution.status(f.executionRef, request.requestId)).effect, 'completed');
  } finally { await f.stop(); }
});
test('lost controlled transport ACK and absent readback preserve unknown without replay or secret diagnostics', async () => {
  const f = await fixture('lost_ack'); try {
    const request = f.request(); await assert.rejects(f.execution.request(f.executionRef, request), error => {
      assert.ok(error instanceof GatewayError); assert.equal(error.effect, 'effect_unknown');
      assert.equal(JSON.stringify(error.diagnostic).includes('fixture-key-private'), false); assert.equal(JSON.stringify(error.diagnostic).includes('vendor'), false); return true;
    });
    assert.equal((await f.execution.status(f.executionRef, request.requestId)).effect, 'effect_unknown');
    await assert.rejects(f.execution.status(f.executionRef, 'absent-record'), denied('effect_unknown'));
    await assert.rejects(f.client.operation('absent-operation'), denied('effect_unknown'));
    assert.equal(f.stats().entries, 0); assert.equal(f.stats().calls, 1);
  } finally { await f.stop(); }
});
test('missing protected composition, expired worker, policy fence and restore fail closed', async () => {
  const missing = await fixture('missing'); try { await assert.rejects(missing.execution.request(missing.executionRef, missing.request()), denied()); assert.equal(missing.stats().calls, 0); } finally { await missing.stop(); }
  const f = await fixture(); try {
    await pool.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2", [f.context.consumerId, f.worker]);
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied()); assert.equal(f.stats().entries, 0);
    const fence = await f.client.fence({ operationId: randomUUID(), subjectRef: 'binding-fixture', revision: 2 }); assert.equal(fence.state, 'applied'); assert.equal('result' in fence, false);
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied());
    await f.kernel.restore(f.context, f.saved.admission.issuerEpoch, randomUUID()); await assert.rejects(f.execution.request(f.executionRef, f.request()), denied());
  } finally { await f.stop(); }
});
test('output byte cap and stream cancellation classify unknown and retain occupied native transport', async () => {
  for (const mode of ['overflow', 'held'] as const) {
    const f = await fixture(mode); try {
      const request = f.request(), result = await f.execution.request(f.executionRef, request); assert.equal(result.kind, 'stream');
      if (result.kind !== 'stream') throw new Error('expected synthetic stream');
      if (mode === 'overflow') await assert.rejects(consume(result));
      else { const reader = result.body.getReader(); assert.equal((await reader.read()).done, false); await result.cancel(); }
      for (let tries = 0; tries < 30 && (await f.kernel.request(f.context, f.executionRef, request.requestId)).effect !== 'effect_unknown'; tries++) await delay(10);
      assert.equal((await f.kernel.request(f.context, f.executionRef, request.requestId)).effect, 'effect_unknown');
      assert.equal((await pool.query('SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND id=$2', [f.context.consumerId, request.requestId])).rows[0].transport_occupied, true);
      assert.ok(f.stats().cancelled > 0);
    } finally { await f.stop(); }
  }
});
test('execution close is scoped, idempotent acknowledgement without a wrong result variant', async () => {
  const f = await fixture(); try {
    const input = { operationId: randomUUID(), reason: 'cancelled' as const };
    const closed = await f.execution.close(f.executionRef, input); assert.equal(closed.state, 'applied'); assert.equal('result' in closed, false);
    assert.deepEqual(await f.execution.close(f.executionRef, input), closed); assert.deepEqual(await f.execution.operation(input.operationId), closed);
    const response = await f.raw('/v1/executions/' + f.executionRef, 'GET', undefined, f.executionGrant.token); assert.equal(c.execution.parse(await response.json()).state, 'terminal');
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied());
  } finally { await f.stop(); }
});

test('expired persisted deadline and restored issuer independently prevent native entry', async () => {
  for (const kind of ['deadline', 'restore'] as const) {
    const f = await fixture(); try {
      if (kind === 'deadline') await pool.query("UPDATE ag_kernel.executions SET deadline=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2", [f.context.consumerId, f.executionRef]);
      else await f.kernel.restore(f.context, f.saved.admission.issuerEpoch, randomUUID());
      assert.equal((await f.kernel.savedExecution(f.context, f.executionRef)).dispatchAllowed, false);
      await assert.rejects(f.execution.request(f.executionRef, f.request()), denied()); assert.equal(f.stats().calls, 0);
    } finally { await f.stop(); }
  }
});
test('native effect and cleanup cancellation require exact persisted proof and existing cleanup lease', async () => {
  const f = await fixture(); try {
    const request = f.request(); await consume(await f.execution.request(f.executionRef, request));
    const { proof, callback } = f.last();
    await assert.rejects(callback.effect({ ...proof, token: randomUUID() }, 'effect_unknown'));
    await f.execution.close(f.executionRef, { operationId: randomUUID(), reason: 'completed' });
    const claim = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(claim && claim.scope.kind === 'execution');
    const authority = { cleanupRef: claim.cleanupRef, token: claim.token };
    await assert.rejects(cancelFacadeTransport(f.options, f.context, { ...proof, token: randomUUID() }, authority));
    assert.equal(f.stats().cancelled, 0);
    await cancelFacadeTransport(f.options, f.context, proof, authority); assert.equal(f.stats().cancelled, 1);
    assert.equal((await pool.query('SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND id=$2', [f.context.consumerId, request.requestId])).rows[0].transport_occupied, true);
    await callback.closed(proof, authority); await f.kernel.settleCleanup(f.context, claim.cleanupRef, f.worker, claim.token, true);
    assert.equal((await f.kernel.request(f.context, f.executionRef, request.requestId)).effect, 'completed');
  } finally { await f.stop(); }
});

test('actual listener rejects absent/duplicate Authorization, duplicated content type and malformed request headers', async () => {
  const f = await fixture(); try {
    const origin = new URL(f.origin);
    async function wire(headers: readonly string[]): Promise<{ status: number; body: unknown }> {
      return new Promise((resolve, reject) => {
        const socket = connectSocket({ host: '127.0.0.1', port: Number(origin.port) });
        const chunks: Buffer[] = [];
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('bounded fixture socket timeout')); });
        socket.once('error', reject); socket.on('data', data => chunks.push(data));
        socket.once('connect', () => socket.write('GET /v1/profiles HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept: application/json\r\n' + headers.join('\r\n') + '\r\n\r\n'));
        socket.once('end', () => {
          try {
            const text = Buffer.concat(chunks).toString(), [head, body] = text.split('\r\n\r\n');
            resolve({ status: Number(head.split(' ')[1]), body: JSON.parse(body) as unknown });
          } catch (error) { reject(error); }
        });
      });
    }
    const auth = 'Authorization: Bearer ' + f.managementGrant.token, type = 'Content-Type: application/json';
    for (const headers of [[type], [type, auth, auth]]) { const result = await wire(headers); assert.equal(result.status, 401); c.safeError.parse(result.body); }
    for (const headers of [[auth, type, type], [auth, 'Content-Type: text/plain'], [type, auth, ...Array.from({ length: 32 }, (_, i) => 'X-Fixture-' + i + ': a'), auth]]) {
      const result = await wire(headers); assert.equal(result.status, 400); c.safeError.parse(result.body);
    }
    const response = await fetch(f.origin + '/v1/executions/' + f.executionRef + '/requests', { method: 'POST', headers: {
      authorization: 'Bearer ' + f.executionGrant.token, 'content-type': 'application/json', accept: 'text/event-stream',
      'x-gateway-request-id': 'bad/id', 'x-gateway-admission': JSON.stringify(f.admission) }, body: nativeBytes() });
    assert.equal(response.status, 400); c.safeError.parse(await response.json()); assert.equal(f.stats().calls, 0);
  } finally { await f.stop(); }
});

test('original fractional admission tokens and prototype query names are rejected by the actual listener', async () => {
  const f = await fixture(); try {
    const header = JSON.stringify(f.admission);
    const fields = ['authorizationEpoch', 'policyRevision', 'bindingRevision', 'requests', 'concurrency', 'requestBytes', 'outputBytes', 'tokens'];
    for (const field of fields) {
      const malformed = header.replace(new RegExp('"' + field + '":(\\d+)'), '"' + field + '":$1.000000000000000001');
      assert.notEqual(malformed, header);
      const response = await fetch(f.origin + '/v1/executions/' + f.executionRef + '/requests', { method: 'POST', headers: {
        authorization: 'Bearer ' + f.executionGrant.token, 'content-type': 'application/json', accept: 'text/event-stream',
        'x-gateway-request-id': randomUUID(), 'x-gateway-admission': malformed }, body: nativeBytes() });
      assert.equal(response.status, 400); c.safeError.parse(await response.json());
    }
    for (const query of ['__proto__=ignored', 'constructor=ignored', 'ownerRef=workspace-fixture&ownerRef=workspace-fixture']) {
      const response = await f.raw('/v1/accounts?' + query); assert.equal(response.status, 400); c.safeError.parse(await response.json());
    }
    assert.equal(f.stats().calls, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1', [f.context.consumerId])).rows[0].n, 0);
  } finally { await f.stop(); }
});

test('management operation readback preserves the configured owner scope within one consumer', async () => {
  const f = await fixture(); try {
    const otherToken = 'fixture-other-owner-' + randomUUID();
    f.bearers.replace([f.managementGrant, f.executionGrant, { ...f.managementGrant, token: otherToken, ownerRefs: ['workspace-other-fixture'] }]);
    const other = createManagementClient({ role: 'management', origin: f.origin, token: otherToken });
    const created = await other.connect({ operationId: randomUUID(), ownerRef: 'workspace-other-fixture', profileId: profile.profile,
      displayName: 'Other owner fixture', credential: { kind: 'api_key', value: 'fixture-other-owner-key' } });
    assert.ok(created.state === 'applied' && created.result?.kind === 'account');
    assert.deepEqual(await other.operation(created.operationRef), created);
    await assert.rejects(f.client.get(created.result.accountRef), denied());
    await assert.rejects(f.client.operation(created.operationRef), denied());
    await assert.rejects(other.operation(f.created.operationRef), denied());
  } finally { await f.stop(); }
});

test('empty server-approved account set permits enrollment while denying execution preparation', async () => {
  const f = await fixture(); try {
    f.bearers.replace([{ ...f.managementGrant, preparation: { ...f.managementGrant.preparation, accountRefs: [] } }]);
    const created = await f.client.connect({ operationId: randomUUID(), ownerRef: 'workspace-fixture', profileId: profile.profile,
      displayName: 'New enrollment', credential: { kind: 'api_key', value: 'fixture-new-enrollment-key' } });
    assert.ok(created.state === 'applied' && created.result?.kind === 'account');
    assert.equal((await f.client.get(created.result.accountRef)).state, 'active');
    await assert.rejects(f.client.prepare({ ...f.preparedInput, operationId: randomUUID(), invocationRef: randomUUID(), accountRefs: [created.result.accountRef] }), denied('not_dispatched'));
    assert.equal(f.stats().calls, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1', [f.context.consumerId])).rows[0].n, 0);
  } finally { await f.stop(); }
});
