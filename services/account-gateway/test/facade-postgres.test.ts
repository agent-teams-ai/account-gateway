import { claudeOAuthProfile } from '../src/oauth-profiles.ts';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as c from '@agent-teams/account-gateway/contracts';
import { createAccountLimitsClient, createManagementClient, createExecutionClient, createConsumerControlClient, createLifecycleClient, GatewayError } from '@agent-teams/account-gateway/http';
import { createFacade, FacadeBearers, cancelFacadeTransport } from '../src/facade.ts';
import type { FacadeOptions, ManagementBearer, ConsumerControlBearer, NativeCallback, NativePermit, NativeTransport } from '../src/facade.ts';
import { PostgresKernel } from '../src/postgres.ts';
import { AccountManagement, codexOAuthProfile } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { NativeAccountLimitsClient, NativeManagementClient, NativeOAuthEnrollmentClient } from '../src/native-client.ts';
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
async function fixture(mode: 'normal' | 'lost_ack' | 'overflow' | 'held' | 'missing' = 'normal', controlProfiles = false,
  lifetime: { readonly streamDurationMs?: number; readonly deadlineMs?: number } = {},
  lifecycle?: FacadeOptions['lifecycle']) {
  const context = { consumerId: 'facade-' + randomUUID() }, kernel = new PostgresKernel(pool);
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32)), store = new PostgresManagementStore(pool, custody);
  const worker = randomUUID(), incarnation = randomUUID(), managementToken = 'fixture-management-' + randomUUID(), executionToken = 'fixture-execution-' + randomUUID();
  await kernel.heartbeat(context, worker);
  let creates = 0, calls = 0, entries = 0, cancelled = 0, oauthReads = 0;
  let custodyReady = true;
  let last: { callback: NativeCallback; proof: NativeDispatchProof; permit: NativePermit } | undefined;
  const raws: Uint8Array[] = [], nativeRows = new Map<string, { descriptor: object; state: string }>();
  const native = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      if (req.url === '/private/native/v1/oauth/connect' || req.url === '/private/native/v1/oauth/connect/read') {
        if (req.url.endsWith('/read')) oauthReads++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ operation: input.operation, account_ref: input.account_ref, state: 'prepared' })); return;
      }
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
  const management = new AccountManagement({ kernel, store, custody, worker, profiles: [profile], oauth: controlProfiles ? { profile: { ...codexOAuthProfile, qualificationRef: 'synthetic-only' },
      native: new NativeOAuthEnrollmentClient({ origin: nativeOrigin, consumerId: context.consumerId, ownerRef: 'new-opaque-owner', controlCredential: 'synthetic-control' }) } : undefined, proof: { async verify() { return true; } },
    retainedCustody: { async verify(mapping) { return custodyReady ? { contract: 'native-retained-custody/v1', generation: mapping.generation,
      nativePhysicalIdentity: mapping.descriptor.nativePhysicalIdentity, credentialKinds: ['api_key'] } : undefined; } },
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
      if (lifetime.streamDurationMs !== undefined) {
        const finishAt = performance.now() + lifetime.streamDurationMs;
        while (performance.now() < finishAt) {
          try { await delay(250, undefined, { signal: input.signal }); }
          catch (error) { if (input.signal.aborted) return; throw error; }
          if (input.signal.aborted) return;
          yield Buffer.from('data: synthetic-progress\n\n');
        }
      }
      if (mode === 'held') {
        await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); }); return;
      }
      await input.callback.effect(proof, 'completed');
      // No closure inference from yielded output or the TS socket. Tests invoke
      // the exact synthetic native teardown acknowledgement separately.
    })() };
  }, async cancel() { cancelled++; } };
  const options: FacadeOptions = { kernel, management, store, bearers, profiles: [{ dto: safeProfile, maxOutputTokens: 1000 }, ...(controlProfiles ? [
      { dto: { ...safeProfile, profileId: 'ungranted-profile' }, maxOutputTokens: 1000 },
      { dto: { ...safeProfile, profileId: codexOAuthProfile.profile, modelIds: [codexOAuthProfile.model], authKinds: ['oauth'] as c.Profile['authKinds'] }, maxOutputTokens: 1000 },
    ] : [])],
    intentHmacKey: randomBytes(32), enrollment: mode === 'missing' ? undefined : { originRef: 'synthetic-origin', engineIncarnation: incarnation, worker }, transport: mode === 'missing' ? undefined : transport,
    timeoutMs: 5000, bufferBytes: 4096, ...(lifecycle ? { lifecycle } : {}) };
  const server = createFacade(options);
  const origin = await listen(server), client = createManagementClient({ role: 'management', origin, token: managementToken });
  try {
  const created = await client.connect({ operationId: randomUUID(), ownerRef: 'workspace-fixture', profileId: profile.profile, displayName: 'Fixture', credential: { kind: 'api_key', value: 'fixture-key-private' } });
  assert.equal(created.state, 'applied'); assert.ok(created.state === 'applied' && created.result?.kind === 'account');
  const accountRef = created.result.accountRef;
  managementGrant = { ...managementGrant, preparation: { ...managementGrant.preparation, accountRefs: [accountRef] } }; bearers.replace([managementGrant]);
  const preparedInput: c.Prepare = { operationId: randomUUID(), invocationRef: 'invocation-' + randomUUID(), attemptRef: 'attempt-fixture', accountRefs: [accountRef],
    subjectRef: 'binding-fixture', policyRevision: 2, bindingRevision: 3, profileId: profile.profile, limits, deadline: new Date(Date.now() + (lifetime.deadlineMs ?? 45_000)).toISOString() };
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
    request, raw, options, setCustodyReady: (ready: boolean) => { custodyReady = ready; },
    stats: () => ({ creates, calls, entries, cancelled, oauthReads }), last: () => { assert.ok(last); return last; }, raws,
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
test('feature default hides lifecycle writes; explicit gate suspends and resumes with old-reader fail-closed', async () => {
  const off = await fixture();
  try {
    const hidden = createLifecycleClient({ role: 'management', origin: off.origin, token: off.managementGrant.token,
      capability: c.LIFECYCLE_CAPABILITY_CONTRACT, clientContract: c.LIFECYCLE_CLIENT_CONTRACT });
    assert.equal((await hidden.capability()).writeGate, 'disabled');
    await assert.rejects(hidden.suspend(off.accountRef, { operationId: randomUUID(), expectedMetadataRevision: 1 }), denied());
  } finally { await off.stop(); }

  const gate = { contract: c.LIFECYCLE_CAPABILITY_CONTRACT, writeGate: 'enabled' as const };
  const f = await fixture('normal', false, {}, gate);
  try {
    const lifecycle = createLifecycleClient({ role: 'management', origin: f.origin, token: f.managementGrant.token,
      capability: c.LIFECYCLE_CAPABILITY_CONTRACT, clientContract: c.LIFECYCLE_CLIENT_CONTRACT });
    assert.deepEqual(await lifecycle.capability(), { ...gate, clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
      operations: ['suspend', 'resume'], custody: { contract: 'native-retained-custody/v1',
        api_key: 'native-attestation-required', oauth: 'native-attestation-required' } });
    const current = await lifecycle.get(f.accountRef);
    assert.equal(current.authKind, 'api_key'); assert.equal(current.resumeCustody, 'not_applicable');
    const suspendId = randomUUID();
    const suspended = await lifecycle.suspend(f.accountRef, { operationId: suspendId, expectedMetadataRevision: current.metadataRevision });
    assert.ok(suspended.state === 'applied' && suspended.result.account.state === 'suspended');
    assert.deepEqual(await lifecycle.operation(suspendId), suspended);
    assert.deepEqual(await lifecycle.suspend(f.accountRef, { operationId: suspendId, expectedMetadataRevision: current.metadataRevision }), suspended);
    await assert.rejects(f.client.get(f.accountRef), error => error instanceof GatewayError && error.effect === 'not_dispatched');
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied());

    f.setCustodyReady(false);
    const unavailable = await lifecycle.resume(f.accountRef, { operationId: randomUUID(),
      expectedMetadataRevision: suspended.result.account.metadataRevision });
    assert.equal(unavailable.state, 'rejected');
    assert.equal(unavailable.account.resumeCustody, 'attention_required');
    f.setCustodyReady(true);
    const resumed = await lifecycle.resume(f.accountRef, { operationId: randomUUID(),
      expectedMetadataRevision: suspended.result.account.metadataRevision });
    assert.ok(resumed.state === 'applied' && resumed.result.account.state === 'active');
    assert.equal(resumed.result.account.metadataRevision, suspended.result.account.metadataRevision + 1);
    assert.equal(resumed.result.account.authorizationEpoch, suspended.result.account.authorizationEpoch + 1);
    assert.deepEqual(await lifecycle.operation(suspendId), suspended, 'original result survives resume');
    assert.deepEqual(await lifecycle.suspend(f.accountRef, { operationId: suspendId, expectedMetadataRevision: current.metadataRevision }), suspended);
    assert.equal((await lifecycle.list({ ownerRef: current.ownerRef })).accounts[0]?.state, 'active');
  } finally { await f.stop(); }
});
test('exported SDK preparation with fresh operation IDs reads the original execution before and after unknown fencing', async () => {
  const f = await fixture('lost_ack'); try {
    assert.ok(f.prepared.state === 'applied' && f.prepared.result?.kind === 'execution');
    const original = f.prepared.result;
    assert.equal(original.accountRef, f.accountRef);
    assert.equal(original.authorizationEpoch, f.saved.admission.authorizationEpoch);
    // The existing kernel sticky-identity contract is the oracle, not an HMAC
    // recomputed from facade implementation details.
    async function readback(state: c.Execution['state']): Promise<void> {
      const operationId = randomUUID();
      const result = await f.client.prepare({ ...f.preparedInput, operationId });
      assert.equal(result.operationRef, operationId); assert.equal(result.state, 'applied');
      assert.ok(result.state === 'applied' && result.result?.kind === 'execution');
      assert.deepEqual(result.result, { ...original, state });
      assert.deepEqual(await f.client.operation(operationId), result);
      const saved = await f.kernel.savedExecution(f.context, original.executionRef);
      assert.deepEqual(saved.admission, f.saved.admission); assert.equal(saved.generation, f.saved.generation);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.executions WHERE consumer=$1', [f.context.consumerId])).rows[0].n, 1);
    }
    await readback('active');
    // The existing fixture permits concurrency=1, also the kernel minimum.
    // Its increase is denied by the original server policy; lower valid caps
    // and a shorter approved deadline reach the persisted intent comparison.
    const changed: { patch: Partial<c.Prepare>; status: number; code: c.SafeError['code'] }[] = [{
      patch: { deadline: new Date(Date.parse(f.preparedInput.deadline) - 1000).toISOString() }, status: 409, code: 'conflict' }];
    for (const key of Object.keys(limits) as (keyof typeof limits)[])
      changed.push({ patch: { limits: { ...limits, [key]: key === 'concurrency' ? 2 : limits[key] - 1 } },
        status: key === 'concurrency' ? 403 : 409, code: key === 'concurrency' ? 'forbidden' : 'conflict' });
    for (const { patch, status, code } of changed) {
      const response = await f.raw('/v1/executions', 'POST', { ...f.preparedInput, operationId: randomUUID(), ...patch });
      assert.equal(response.status, status); assert.equal(c.safeError.parse(await response.json()).code, code);
    }
    const request = f.request();
    await assert.rejects(f.execution.request(f.executionRef, request), denied('effect_unknown'));
    assert.equal((await f.execution.status(f.executionRef, request.requestId)).effect, 'effect_unknown');
    await readback('fenced');
    // Prove the unknown fence alone denies a fresh request, before reconnect
    // introduces an independent epoch change that could mask a fence defect.
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied('not_dispatched'));
    assert.equal(f.stats().calls, 1); assert.equal(f.stats().entries, 0);
    const changedAfterUnknown = await f.raw('/v1/executions', 'POST', { ...f.preparedInput, operationId: randomUUID(), ...changed[0].patch });
    assert.equal(changedAfterUnknown.status, 409); assert.equal(c.safeError.parse(await changedAfterUnknown.json()).code, 'conflict');
    // Changing current account metadata/epoch cannot replace the saved choice.
    const current = await f.client.get(f.accountRef);
    const reconnected = await f.client.reconnect(f.accountRef, { operationId: randomUUID(), expectedMetadataRevision: current.metadataRevision,
      credential: { kind: 'api_key', value: 'test-fixture-literal' } });
    assert.ok(reconnected.state === 'applied' && reconnected.result?.kind === 'account');
    assert.equal(reconnected.result.authorizationEpoch, original.authorizationEpoch + 1);
    await readback('fenced');
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied('not_dispatched'));
    assert.equal(f.stats().calls, 1); assert.equal(f.stats().entries, 0);
    const persisted = (await pool.query('SELECT request_count,state FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [f.context.consumerId, f.executionRef])).rows[0];
    assert.equal(persisted.request_count, 1); assert.equal(persisted.state, 'fenced');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1', [f.context.consumerId])).rows[0].n, 1);
    await assert.rejects(f.client.prepare({ ...f.preparedInput, operationId: randomUUID(), bindingRevision: 4 }), denied('not_dispatched'));
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
    const blocked = f.request();
    const busy = await f.execution.request(f.executionRef, blocked);
    assert.ok(busy.kind === 'status');
    assert.equal(busy.status.status, 'failed'); assert.equal(busy.status.effect, 'not_dispatched');
    assert.equal(busy.status.error?.code, 'admission_limited');
    assert.deepEqual(busy.status.error?.retry, { kind: 'after', milliseconds: 1000 });
    assert.equal(f.stats().entries, 1);
    const deniedRow = (await pool.query(`SELECT code,transport_occupied,native_origin_ref,engine_incarnation,descriptor_generation
      FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3`, [f.context.consumerId, f.executionRef, blocked.requestId])).rows[0];
    assert.deepEqual(deniedRow, { code: 'concurrency_limit', transport_occupied: false,
      native_origin_ref: null, engine_incarnation: null, descriptor_generation: null });
    await assert.rejects(last.callback.closed({ ...last.proof, token: randomUUID() }));
    await last.callback.closed(last.proof); assert.equal((await f.execution.status(f.executionRef, request.requestId)).effect, 'completed');
    const repeated = await f.execution.request(f.executionRef, blocked);
    assert.ok(repeated.kind === 'status');
    assert.equal(repeated.status.effect, 'not_dispatched');
    assert.equal(repeated.status.requestRef, blocked.requestId);
    assert.deepEqual(repeated.status.error?.retry, { kind: 'after', milliseconds: 1000 });
    assert.equal(f.stats().entries, 1, 'a denied request identity never becomes dispatchable');
    for (let admitted = 1; admitted < limits.requests; admitted++) {
      const next = await f.execution.request(f.executionRef, f.request());
      assert.ok(next.kind === 'stream'); await consume(next);
      const completed = f.last(); await completed.callback.closed(completed.proof);
    }
    const quota = await f.execution.request(f.executionRef, f.request());
    assert.ok(quota.kind === 'status');
    assert.equal(quota.status.status, 'failed'); assert.equal(quota.status.effect, 'not_dispatched');
    assert.equal(quota.status.error?.code, 'admission_limited');
    assert.deepEqual(quota.status.error?.retry, { kind: 'never' });
    assert.equal(f.stats().entries, limits.requests);
    assert.equal((await pool.query('SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
      [f.context.consumerId, f.executionRef])).rows[0].request_count, limits.requests);
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
// The first scenario fails when the HTTP arrival timer cuts off a progressing
// admitted stream. The companion fails if switching budgets loses saved expiry
// or treats cancellation as proof of native closure/replay permission.
test('progressing admitted HTTP stream completes beyond the ingress budget before saved expiry', { timeout: 20_000 }, async () => {
  const f = await fixture('normal', false, { streamDurationMs: 6500, deadlineMs: 20_000 }); try {
    const request = f.request(), startedAt = Date.now();
    const result = await f.execution.request(f.executionRef, request);
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') throw new Error('expected synthetic stream');
    const reader = result.body.getReader(); let lastProgressAt = startedAt, bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      lastProgressAt = Date.now(); bytes += part.value.byteLength;
    }
    assert.ok(lastProgressAt - startedAt > 5500, 'real HTTP chunks must progress beyond the 5000ms ingress budget');
    assert.ok(lastProgressAt < Date.parse(f.saved.admission.expiresAt));
    assert.ok(bytes > Buffer.byteLength('data: synthetic-fixture\n\n'));
    assert.equal((await f.execution.status(f.executionRef, request.requestId)).effect, 'completed');
    assert.equal(f.stats().calls, 1); assert.equal(f.stats().entries, 1); assert.equal(f.stats().cancelled, 0);
    assert.equal((await pool.query('SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [f.context.consumerId, f.executionRef])).rows[0].request_count, 1);
  } finally { await f.stop(); }
});
test('progressing admitted HTTP stream still expires and retains unknown native occupancy', { timeout: 25_000 }, async () => {
  const f = await fixture('normal', false, { streamDurationMs: 20_000, deadlineMs: 8500 }); try {
    const request = f.request(), startedAt = Date.now();
    const result = await f.execution.request(f.executionRef, request);
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') throw new Error('expected synthetic stream');
    const reader = result.body.getReader(); let lastProgressAt = startedAt;
    await assert.rejects(async () => {
      for (;;) {
        const part = await reader.read(); if (part.done) return;
        lastProgressAt = Date.now();
      }
    });
    assert.ok(lastProgressAt - startedAt > 5500, 'saved expiry must allow progress beyond the ingress budget');
    const deadlineAt = Date.parse(f.saved.admission.expiresAt);
    assert.ok(lastProgressAt >= deadlineAt - 1000, 'real HTTP progress must continue until near saved expiry');
    assert.ok(Date.now() >= deadlineAt - 100, 'progress cannot cancel the saved deadline');
    for (let tries = 0; tries < 100 && (await f.kernel.request(f.context, f.executionRef, request.requestId)).effect !== 'effect_unknown'; tries++) await delay(10);
    assert.equal((await f.kernel.request(f.context, f.executionRef, request.requestId)).effect, 'effect_unknown');
    const persisted = (await pool.query('SELECT r.transport_occupied,e.request_count,e.state FROM ag_kernel.requests r JOIN ag_kernel.executions e ON e.consumer=r.consumer AND e.ref=r.execution_ref WHERE r.consumer=$1 AND r.id=$2', [f.context.consumerId, request.requestId])).rows[0];
    assert.equal(persisted.transport_occupied, true); assert.equal(persisted.request_count, 1); assert.equal(persisted.state, 'fenced');
    assert.ok(f.stats().cancelled > 0);
    await assert.rejects(f.execution.request(f.executionRef, f.request()), denied('not_dispatched'));
    assert.equal(f.stats().calls, 1); assert.equal(f.stats().entries, 1);
  } finally { await f.stop(); }
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

test('exported SDK account pagination scopes single and multiple configured owners before sizing pages and cursors', async () => {
  const f = await fixture(); try {
    const owners = ['workspace-fixture', 'workspace-other-fixture', 'workspace-third-fixture'];
    f.bearers.replace([{ ...f.managementGrant, ownerRefs: owners }, f.executionGrant]);
    const created: { accountRef: string; ownerRef: string }[] = [{ accountRef: f.accountRef, ownerRef: owners[0] }];
    for (const ownerRef of owners) {
      for (let i = ownerRef === owners[0] ? 1 : 0; i < 3; i++) {
        const result = await f.client.connect({ operationId: randomUUID(), ownerRef, profileId: profile.profile,
          displayName: 'Pagination fixture', credential: { kind: 'api_key', value: 'test-fixture-literal' } });
        assert.ok(result.state === 'applied' && result.result?.kind === 'account');
        created.push({ accountRef: result.result.accountRef, ownerRef });
      }
    }
    created.sort((a, b) => a.accountRef < b.accountRef ? -1 : a.accountRef > b.accountRef ? 1 : 0);
    // Observed UUID order supplies deterministic expected pages. Exclude the
    // first row's owner so old consumer-wide pagination always leaks its cursor.
    const foreignOwner = created[0].ownerRef, allowed = owners.filter(owner => owner !== foreignOwner);
    for (const allowedOwners of [[allowed[0]], allowed]) {
      f.bearers.replace([{ ...f.managementGrant, ownerRefs: allowedOwners }, f.executionGrant]);
      for (const ownerRef of [undefined, ...allowedOwners]) {
        const expected = created.filter(row => allowedOwners.includes(row.ownerRef) && (ownerRef === undefined || row.ownerRef === ownerRef));
        for (const limit of [1, 2]) {
          let cursor: string | undefined;
          const seen: string[] = [];
          for (let offset = 0; offset < expected.length; offset += limit) {
            const page = await f.client.list({ limit, ...(ownerRef === undefined ? {} : { ownerRef }), ...(cursor === undefined ? {} : { cursor }) });
            if (page.nextCursor !== undefined) assert.ok(expected.some(row => row.accountRef === page.nextCursor), 'cursor must belong to an allowed owner');
            assert.ok(page.accounts.length > 0, 'foreign accounts must not create empty pages');
            assert.deepEqual(page.accounts.map(a => a.accountRef), expected.slice(offset, offset + limit).map(a => a.accountRef));
            assert.ok(page.accounts.every(a => allowedOwners.includes(a.ownerRef)));
            assert.equal(page.nextCursor, offset + limit < expected.length ? expected[offset + limit - 1].accountRef : undefined);
            seen.push(...page.accounts.map(a => a.accountRef)); cursor = page.nextCursor;
          }
          assert.deepEqual(seen, expected.map(a => a.accountRef)); assert.equal(cursor, undefined);
        }
      }
      await assert.rejects(f.client.list({ ownerRef: foreignOwner, limit: 1 }), denied('not_dispatched'));
    }
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

test('consumer-control SDK admits a new opaque owner and fences profiles, consumers and execution roles', async () => {
  const f = await fixture('normal', true); try {
    const ownerRef = 'new-opaque-owner', token = 'synthetic-consumer-' + randomUUID();
    const control: ConsumerControlBearer = { role: 'consumer-control', token, consumerId: f.context.consumerId,
      profileIds: [profile.profile, codexOAuthProfile.profile], limits, maxRunMs: 60_000 };
    const narrow = { ...control, token: 'synthetic-narrow-' + randomUUID(), profileIds: ['ungranted-profile'] };
    const foreign = { ...control, token: 'synthetic-foreign-' + randomUUID(), consumerId: 'foreign-' + randomUUID() };
    const run = { ...control, role: 'run-control' as const, token: 'synthetic-run-' + randomUUID(), ownerRefs: ['workspace-fixture'] };
    f.bearers.replace([f.managementGrant, f.executionGrant, control, narrow, foreign, run]);
    const client = createConsumerControlClient({ role: 'consumer-control', origin: f.origin, token });
    const restricted = createConsumerControlClient({ role: 'consumer-control', origin: f.origin, token: narrow.token });
    const other = createConsumerControlClient({ role: 'consumer-control', origin: f.origin, token: foreign.token });
    const connect = { operationId: randomUUID(), ownerRef, profileId: profile.profile, displayName: 'Dynamic',
      credential: { kind: 'api_key' as const, value: 'synthetic-dynamic-key' } };
    await assert.rejects(f.client.connect(connect), denied('not_dispatched'));
    await assert.rejects(restricted.connect(connect), denied('not_dispatched'));
    await assert.rejects(client.connect({ ...connect, profileId: 'ungranted-profile' }), denied('not_dispatched'));
    assert.equal((await f.raw('/v1/accounts', 'POST', { ...connect, consumerId: foreign.consumerId }, token)).status, 400);
    const created = await client.connect(connect);
    assert.ok(created.state === 'applied' && created.result?.kind === 'account');
    const ref = created.result.accountRef, account = await client.get(ref);
    assert.equal(account.ownerRef, ownerRef); assert.equal(account.profileId, profile.profile);
    assert.deepEqual(await client.operation(connect.operationId), created);
    assert.deepEqual((await client.profiles()).profiles.map(p => p.profileId), control.profileIds);
    assert.deepEqual((await client.list({ ownerRef, limit: 1 })).accounts, [account]);
    assert.throws(() => client.list({} as { ownerRef: string }), e => e instanceof GatewayError && e.code === 'invalid_input');
    assert.equal((await f.raw('/v1/accounts', 'GET', undefined, token)).status, 403);
    assert.deepEqual((await restricted.list({ ownerRef })).accounts, []);
    for (const deniedClient of [restricted, other]) {
      await assert.rejects(deniedClient.get(ref), denied());
      await assert.rejects(deniedClient.operation(connect.operationId), denied());
    }
    await assert.rejects(f.client.get(ref), denied());
    const prepare = { ...f.preparedInput, operationId: randomUUID(), invocationRef: 'dynamic-' + randomUUID(),
      accountRefs: [ref], subjectRef: 'opaque-subject' };
    await assert.rejects(restricted.runAccess(prepare), denied()); await assert.rejects(other.runAccess(prepare), denied());
    await assert.rejects(client.runAccess({ ...prepare, profileId: 'ungranted-profile' }), denied());
    for (const key of Object.keys(limits) as (keyof typeof limits)[])
      await assert.rejects(client.runAccess({ ...prepare, limits: { ...limits, [key]: limits[key] + 1 } }), denied());
    await assert.rejects(client.runAccess({ ...prepare, deadline: new Date(Date.now() + 120_000).toISOString() }), denied());
    const access = await client.runAccess(prepare);
    assert.ok(access.operation.state === 'applied' && access.operation.result?.kind === 'execution');
    const saved = await f.kernel.savedExecution(f.context, access.operation.result.executionRef);
    const { executionRef: _ref, issuerEpoch: _epoch, ...admission } = saved.admission;
    assert.deepEqual(access.admission, admission);
    assert.deepEqual(f.bearers.resolve(access.bearer), { role: 'execution', consumerId: f.context.consumerId, saved });
    assert.deepEqual(await client.runAccess(prepare), access);
    assert.deepEqual(await client.operation(prepare.operationId), access.operation);
    await assert.rejects(restricted.operation(prepare.operationId), denied());
    await assert.rejects(other.operation(prepare.operationId), denied());
    const executor = createExecutionClient({ role: 'execution', origin: f.origin, token: access.bearer });
    const closeId = randomUUID(), closed = await executor.close(_ref, { operationId: closeId, reason: 'cancelled' });
    assert.deepEqual(await client.operation(closeId), closed);
    await assert.rejects(restricted.operation(closeId), denied());
    await assert.rejects(other.operation(closeId), denied());
    for (const path of ['/v1/executions', '/v1/executions/' + _ref + '/close', '/v1/executions/' + _ref + '/requests'])
      assert.equal((await f.raw(path, 'POST', prepare, token, path.endsWith('/requests') ? { accept: 'text/event-stream' } : {})).status, 403);
    for (const path of ['/v1/executions/' + _ref, '/v1/executions/' + _ref + '/requests/request-fixture'])
      assert.equal((await f.raw(path, 'GET', undefined, token)).status, 403);
    assert.equal((await f.raw('/v1/accounts/' + ref, 'GET', undefined, access.bearer)).status, 403);
    for (const path of ['/v1/profiles', '/v1/accounts?ownerRef=' + ownerRef])
      assert.equal((await f.raw(path, 'GET', undefined, run.token)).status, 403);
    assert.equal((await f.raw('/internal/v1/run-access', 'POST', { ...prepare, operationId: randomUUID() }, run.token)).status, 403);
    assert.equal(Object.hasOwn(client, 'prepare') || Object.hasOwn(client, 'request') || Object.hasOwn(client, 'close'), false);
    const oauth = { operationId: randomUUID(), ownerRef, profileId: codexOAuthProfile.profile, displayName: 'Dynamic OAuth' };
    const begun = await client.beginOAuth(oauth); assert.equal(begun.operation.state, 'pending');
    const reads = f.stats().oauthReads;
    await assert.rejects(restricted.readOAuth(oauth.operationId), denied()); await assert.rejects(other.readOAuth(oauth.operationId), denied());
    await assert.rejects(restricted.beginOAuth({ ...oauth, operationId: randomUUID() }), denied());
    assert.equal(f.stats().oauthReads, reads, 'profile/consumer denial precedes protected reconciliation');
    assert.deepEqual(await client.readOAuth(oauth.operationId), begun.operation); assert.equal(f.stats().oauthReads, reads + 1);
    const rename = await client.rename(ref, { operationId: randomUUID(), expectedMetadataRevision: account.metadataRevision, displayName: 'Renamed' });
    assert.ok(rename.state === 'applied' && rename.result?.kind === 'account');
    const reconnected = await client.reconnect(ref, { operationId: randomUUID(), expectedMetadataRevision: rename.result.metadataRevision,
      credential: { kind: 'api_key', value: 'synthetic-reconnected-key' } });
    assert.ok(reconnected.state === 'applied' && reconnected.result?.kind === 'account');
    await client.disable(ref, { operationId: randomUUID(), expectedMetadataRevision: reconnected.result.metadataRevision });
    const fence = { operationId: randomUUID(), subjectRef: 'dynamic-fence', revision: 5 };
    await assert.rejects(f.client.fence(fence), denied());
    assert.deepEqual(await client.fence(fence), { operationRef: fence.operationId, state: 'applied' });
    assert.deepEqual(await client.operation(fence.operationId), { operationRef: fence.operationId, state: 'applied' });
    assert.equal(f.stats().calls, 0); assert.equal(f.stats().entries, 0);
  } finally { await f.stop(); }
});

test('consumer-control replacement during real SQL waits denies readback and issuance and revokes derived execution', async () => {
  const f = await fixture(); const lock = await pool.connect(); try {
    const control: ConsumerControlBearer = { role: 'consumer-control', token: 'synthetic-control-' + randomUUID(),
      consumerId: f.context.consumerId, profileIds: [profile.profile], limits, maxRunMs: 60_000 };
    f.bearers.replace([f.managementGrant, control]);
    const client = createConsumerControlClient({ role: 'consumer-control', token: control.token, origin: f.origin });
    for (const mode of ['readback', 'issuance'] as const) {
      const access = await client.runAccess(f.preparedInput);
      const retired = f.bearers.resolve(control.token); assert.ok(retired);
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [f.context.consumerId]);
      const pid: number = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const input = { ...f.preparedInput, operationId: randomUUID(), invocationRef: 'revoked-' + randomUUID() };
      const pending = mode === 'readback' ? client.operation(f.created.operationRef) : client.runAccess(input);
      void pending.catch(() => undefined);
      const deadline = Date.now() + 2000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting;
        if (!waiting) await delay(10);
      }
      assert.equal(waiting, true, 'actual facade SQL await is blocked by the owned fixture transaction');
      f.bearers.replace([f.managementGrant]); await lock.query('ROLLBACK');
      await assert.rejects(pending, denied());
      if (mode === 'issuance') await assert.rejects(f.kernel.operation(f.context, input.operationId),
        e => e instanceof Error && 'code' in e && e.code === 'unknown');
      assert.equal(f.bearers.current(retired), false); assert.equal(f.bearers.resolve(access.bearer), undefined);
      assert.equal((await f.raw('/v1/executions/' + f.executionRef, 'GET', undefined, access.bearer)).status, 401);
      assert.deepEqual(await f.client.operation(f.preparedInput.operationId), f.prepared, 'accepted preparation survives revoke');
      f.bearers.replace([f.managementGrant, control]);
    }
    assert.equal(f.stats().calls, 0); assert.equal(f.stats().entries, 0);
  } finally { await lock.query('ROLLBACK'); lock.release(); await f.stop(); }
});


// Closing writes after a suspension must preserve compatible reads and exact
// original receipts, so rollout rollback does not strand the account inventory.
test('lifecycle off-on-off keeps v2 inventory and original operation reads while refusing writes', async () => {
  const f = await fixture(); let original: c.LifecycleOperation | undefined;
  try {
    for (const writeGate of ['disabled','enabled','disabled'] as const) {
      const server = createFacade({ ...f.options, lifecycle: { contract: c.LIFECYCLE_CAPABILITY_CONTRACT, writeGate } });
      const origin = await listen(server);
      const client = createLifecycleClient({ role: 'management', origin, token: f.managementGrant.token,
        capability: c.LIFECYCLE_CAPABILITY_CONTRACT, clientContract: c.LIFECYCLE_CLIENT_CONTRACT });
      try {
        assert.equal((await client.capability()).writeGate, writeGate);
        const current = await client.get(f.accountRef);
        assert.equal((await client.list({ ownerRef: current.ownerRef })).accounts[0]?.accountRef, f.accountRef);
        if (writeGate === 'enabled') {
          original = await client.suspend(f.accountRef, { operationId: randomUUID(), expectedMetadataRevision: current.metadataRevision });
          assert.equal(original.state, 'applied');
        } else {
          for (const action of ['suspend','resume'] as const) await assert.rejects(client[action](f.accountRef,
            { operationId: randomUUID(), expectedMetadataRevision: current.metadataRevision }), denied('not_dispatched'));
          if (original) {
            assert.equal(current.state, 'suspended');
            assert.equal((await client.list({ ownerRef: current.ownerRef })).accounts[0]?.state, 'suspended');
            assert.deepEqual(await client.operation(original.operationRef), original);
          }
        }
      } finally { await stop(server); }
    }
    assert.equal((await f.kernel.account(f.context, f.accountRef)).state, 'suspended');
  } finally { await f.stop(); }
});

// Regression: old quota could escape a reconnect/delete/revoke while the native
// read is awaited. Real PG kernel+mapping and both HTTP adapters fence the result.
for (const family of ['codex', 'claude'] as const) test(`cached ${family} native limits fence owner, epoch, pending reconnect and late revocation`, async () => {
  const context = { consumerId: 'limits-' + randomUUID() }, kernel = new PostgresKernel(pool);
  const secrets = new IntentSecrets(randomBytes(32), randomBytes(32)), store = new PostgresManagementStore(pool, secrets);
  const worker = randomUUID(), operationId = randomUUID();
  const ownerRef = 'limits-owner', p = { ...(family === 'claude' ? claudeOAuthProfile : codexOAuthProfile), qualificationRef: 'controlled-source-v1' };
  await kernel.heartbeat(context, worker);
  const created = await kernel.beginAccount(context, { operationId, kind: 'create', intentDigest: randomUUID(),
    ownerRef, profile: p.profile, displayName: 'Limits fixture' });
  assert.ok(created.accountRef); const accountRef = created.accountRef;
  const permit = await kernel.startCandidate(context, operationId, worker); assert.ok(permit);
  const generation = permit.candidate;
  const journal = await store.journal({ ...context, operationId, accountRef, ownerRef, purpose: 'create' }, generation, worker, p);
  await store.saveMapping({ ...journal, descriptor: { ...p, nativeId: 42, generation, nativePhysicalIdentity: generation, createdAt: '2026-10-22T00:00:00Z' } });
  await kernel.acknowledgeCandidate(context, operationId, worker, { generation, nativePhysicalIdentity: generation, profile: p.profile });
  const a = await kernel.account(context, accountRef);
  const input = { accountRef, ownerRef, profileId: p.profile, expectedAuthorizationEpoch: a.epoch };
  let entered = 0, hold: Promise<void> | undefined, onRead: (() => void) | undefined;
  let nativeResult: c.AccountLimits = { status: 'snapshot', physicalGeneration: generation, principalVersion: 'principal-v1', revision: 1,
    scope: family === 'claude' ? 'subscription' : 'account', windows: [{ id: family === 'claude' ? 'claude-5h' : 'primary', family, durationSeconds: 18000, usedPercent: 37.5,
      observedAt: '2026-10-22T00:00:00Z', resetAt: null, basis: 'duration' }] };
  const native = createServer((req, res) => { void (async () => {
    assert.equal(req.headers.authorization, 'Bearer fixture-native-limits');
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/capabilities')) { res.end(JSON.stringify({ contract: 'account-limits/v1', cachedRead: true, quotaOnlyRefresh: false })); return; }
    assert.equal(req.url, '/private/native/v1/account-limits/read');
    entered++; onRead?.(); await hold; res.end(JSON.stringify(nativeResult));
  })().catch(() => res.destroy()); });
  const nativeOrigin = await listen(native);
  const token = 'fixture-limits-' + randomUUID();
  const grant: ConsumerControlBearer = { role: 'consumer-control', token, ...context, profileIds: [p.profile],
    maxRunMs: 60_000, limits };
  const managementToken = 'fixture-limits-management-' + randomUUID(), foreignToken = 'fixture-limits-foreign-' + randomUUID();
  const managementGrant: ManagementBearer = { role: 'management', token: managementToken, ...context, ownerRefs: [ownerRef], profileIds: [p.profile],
    preparation: { accountRefs: [], subjectRef: 'limits-policy', policyRevision: 1, bindingRevision: 1, profileId: profile.profile, limits, maxRunMs: 60_000 } };
  const bearers = new FacadeBearers([grant, managementGrant, { ...managementGrant, token: foreignToken, ownerRefs: ['foreign-owner'] }]);
  const management = new AccountManagement({ kernel, store, custody: secrets, worker, profiles: [profile],
    native: new NativeManagementClient({ origin: nativeOrigin, consumerId: context.consumerId, controlCredential: 'fixture-native-limits' }), proof: { async verify() { return true; } } });
  const facade = createFacade({ kernel, store, management, bearers, profiles: [{ dto: safeProfile, maxOutputTokens: 100, limits }],
    accountLimits: new NativeAccountLimitsClient({ origin: nativeOrigin, consumerId: context.consumerId, controlCredential: 'fixture-native-limits' }),
    intentHmacKey: randomBytes(32) });
  const origin = await listen(facade), client = createAccountLimitsClient({ role: 'consumer-control', origin, token });
  try {
    assert.deepEqual(await client.readAccountLimits(input), nativeResult);
    const expectedSnapshot = nativeResult;
    nativeResult = { ...expectedSnapshot, windows: [{ ...expectedSnapshot.windows[0]!, id: family === 'claude' ? 'primary' : 'claude-5h', family: family === 'claude' ? 'codex' : 'claude' }] };
    assert.deepEqual(await client.readAccountLimits(input), { status: 'unavailable' }, 'a neighboring provider snapshot cannot become this account quota');
    nativeResult = expectedSnapshot;
    assert.equal(entered, 2);
    const forManagement = (token: string) => createAccountLimitsClient({ role: 'management', origin, token });
    assert.deepEqual(await forManagement(managementToken).readAccountLimits(input), nativeResult);
    const beforeForeign = entered;
    await assert.rejects(forManagement(foreignToken).readAccountLimits(input), denied());
    assert.equal(entered, beforeForeign, 'management owner grant checked before native read');
    const renamed = await kernel.beginAccount(context, { operationId: randomUUID(), kind: 'rename', intentDigest: randomUUID(),
      accountRef, expectedRevision: a.revision, displayName: 'Renamed limits fixture' });
    assert.equal(renamed.state, 'applied');
    assert.deepEqual(await client.readAccountLimits(input), nativeResult, 'rename does not replace physical observation');
    const readsBeforeDenied = entered;
    for (const bad of [{ ownerRef: 'foreign-owner' }, { expectedAuthorizationEpoch: a.epoch + 1 }])
      await assert.rejects(client.readAccountLimits({ ...input, ...bad }), denied());
    assert.equal(entered, readsBeforeDenied, 'owner and epoch rejected before native read');
    const response = await fetch(origin + '/v1/account-limits/read', { method: 'POST', headers: { authorization: 'Bearer ' + token,
      'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.headers.get('cache-control'), 'private, no-store'); await response.arrayBuffer();
    nativeResult = { ...nativeResult, physicalGeneration: randomUUID() };
    await assert.rejects(client.readAccountLimits(input), denied());
    nativeResult = { status: 'unknown' };
    assert.deepEqual(await client.readAccountLimits(input), { status: 'unknown' });
    let release!: () => void, observed!: () => void;
    hold = new Promise(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { observed = resolve; }); onRead = observed;
    const late = client.readAccountLimits(input); await waiting;
    const pending = await kernel.beginAccount(context, { operationId: randomUUID(), kind: 'reconnect', intentDigest: randomUUID(), accountRef, expectedRevision: (await kernel.account(context, accountRef)).revision });
    release(); await assert.rejects(late, denied());
    const before = entered; await assert.rejects(client.readAccountLimits(input), denied()); assert.equal(entered, before);
    await pool.query("UPDATE ag_kernel.operations SET state='rejected' WHERE consumer=$1 AND id=$2", [context.consumerId, pending.operationRef]);
    hold = new Promise(resolve => { release = resolve; });
    const revoked = new Promise<void>(resolve => { onRead = resolve; });
    const lateRevoke = client.readAccountLimits(input); await revoked; bearers.replace([]); release();
    await assert.rejects(lateRevoke, denied());
  } finally { await stop(facade); await stop(native); }
});
