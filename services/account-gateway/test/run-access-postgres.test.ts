import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as c from '@agent-teams/account-gateway/contracts';
import { createExecutionClient, GatewayError } from '@agent-teams/account-gateway/http';
import { createFacade, FacadeBearers } from '../src/facade.ts';
import type { ManagementBearer, NativeTransport, RunAccess, RunControlBearer } from '../src/facade.ts';
import { PostgresKernel } from '../src/postgres.ts';
import { KernelError, defaults } from '../src/domain.ts';
import { composeKernelBounds } from '../src/service.ts';
import { AccountManagement, exactCandidate } from '../src/management.ts';
import type { CandidateNative, NativeReadback } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';

// Same fresh-disposable contract and migrated SQL adapters as facade-postgres.
// Its fixture is private to that test file; use the exported production helpers
// here, without copying its native HTTP emulator or exposing test-only hooks.
let pool: pg.Pool;
let nextNativeId = 0;
before(async () => {
  const dsn = process.env.AG_RUN_ACCESS_TEST_DSN, database = process.env.AG_RUN_ACCESS_DISPOSABLE_DB;
  if (!dsn || !database || !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
      process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10') throw new Error('NOT_RUN: explicit NEW disposable PG17.10 run-access database required');
  let url: URL; try { url = new URL(dsn); } catch { throw new Error('NOT_RUN: invalid disposable designation'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + database || url.search || url.hash) throw new Error('NOT_RUN: refusing remote or unspecified database');
  pool = new pg.Pool({ connectionString: dsn, max: 6, connectionTimeoutMillis: 5000 }); pool.on('error', () => undefined);
  try {
    const row = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
    assert.equal(row.db, database); assert.match(row.version, /^17\.10(?:$| )/);
    assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')")).rowCount, 0, 'requires empty disposable database');
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort())
      await pool.query(await readFile(new URL(file, directory), 'utf8'));
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error('NOT_RUN: disposable PostgreSQL setup unavailable; vendor details withheld');
  }
});
after(async () => { await pool?.end(); });
const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const profile = { profile: 'synthetic-profile', baseURL: 'https://fixture.invalid/v1', model: 'fixture-model', qualificationRef: 'synthetic-only' };
const forbidden = (error: unknown): boolean => error instanceof GatewayError && error.code === 'safe_error' && error.effect === 'not_dispatched';

async function fixture(runControlMaxRunMs = 60_000) {
  const context = { consumerId: 'run-access-' + randomUUID() }, worker = randomUUID();
  const control: RunControlBearer = { role: 'run-control', token: 'fixture-control-' + randomUUID(), consumerId: context.consumerId,
    ownerRefs: ['workspace-fixture'], profileIds: [profile.profile], limits: { ...limits }, maxRunMs: runControlMaxRunMs };
  const kernel = new PostgresKernel(pool, composeKernelBounds([control]));
  await kernel.heartbeat(context, worker);
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32)), store = new PostgresManagementStore(pool, custody);
  // Controlled native fixture has no provider. Management and route mappings are
  // still persisted by the real management/kernel SQL implementations.
  const rows = new Map<string, NativeReadback>();
  const native: CandidateNative = {
    async create(j) { rows.set(j.generation, { generation: j.generation, nativePhysicalIdentity: j.generation,
      nativeId: ++nextNativeId, createdAt: '2026-10-03T04:05:06.123456789Z', state: 'inactive', ...profile }); },
    async read(j) { const row = rows.get(j.generation); return row ? [row] : []; },
    async setState(j, state) { const row = rows.get(j.generation); assert.ok(row); rows.set(j.generation, { ...row, state }); },
    async erase(j) { rows.delete(j.generation); },
  };
  const management = new AccountManagement({ kernel, store, custody, worker, profiles: [profile], native,
    proof: { async verify(j, d) { return exactCandidate(j, d) && rows.has(j.generation); } } });
  async function account(ownerRef = 'workspace-fixture') {
    const op = await management.create(context, { operationId: randomUUID(), ownerRef, profile: profile.profile,
      displayName: 'Disposable run access', apiKey: randomUUID() });
    assert.equal(op.state, 'applied'); assert.ok(op.accountRef); return op.accountRef;
  }
  const accountRef = await account();
  const managementGrant: ManagementBearer = { role: 'management', token: 'fixture-management-' + randomUUID(), consumerId: context.consumerId,
    ownerRefs: ['workspace-fixture'], preparation: { accountRefs: [accountRef], subjectRef: 'binding-fixture',
      policyRevision: 2, bindingRevision: 3, profileId: profile.profile, limits: { ...limits }, maxRunMs: 60_000 } };
  const otherConsumer: RunControlBearer = { ...control, token: 'fixture-foreign-' + randomUUID(), consumerId: 'foreign-' + randomUUID() };
  const otherOwner: RunControlBearer = { ...control, token: 'fixture-other-owner-' + randomUUID(), ownerRefs: ['workspace-other'] };
  const bearers = new FacadeBearers([control, managementGrant, otherConsumer, otherOwner]);
  let transportCalls = 0, entries = 0;
  const transport: NativeTransport = { async request(input) {
    transportCalls++;
    const permit = await input.callback.admit(randomUUID());
    if (!permit.claim.dispatch) return { kind: 'status' };
    entries++; const proof = permit.claim.dispatch.closure;
    await input.callback.effect(proof, 'response_started');
    return { kind: 'stream', async cancel() {}, body: (async function* () {
      yield Buffer.from('data: synthetic-fixture\n\n');
      await input.callback.effect(proof, 'completed');
      // Exact synthetic non-provider teardown receipt, not EOF inference.
      await input.callback.closed(proof);
    })() };
  } };
  const safeProfile: c.Profile = { profileId: profile.profile, protocol: 'openai-responses', modelIds: [profile.model], authKinds: ['api_key'] };
  const options = { kernel, management, store, bearers, intentHmacKey: randomBytes(32),
    profiles: [{ dto: safeProfile, maxOutputTokens: 1000 }], transport,
    enrollment: { originRef: 'synthetic-origin', engineIncarnation: randomUUID(), worker }, timeoutMs: 5000, bufferBytes: 4096 };
  let server = createFacade(options);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let origin = 'http://127.0.0.1:' + address.port;
  const input = (patch: Partial<c.Prepare> = {}): c.Prepare => ({ operationId: randomUUID(), invocationRef: randomUUID(), attemptRef: 'attempt-fixture',
    accountRefs: [accountRef], subjectRef: 'binding-fixture', policyRevision: 2, bindingRevision: 3, profileId: profile.profile,
    limits: { ...limits }, deadline: new Date(Date.now() + 45_000).toISOString(), ...patch });
  const raw = (value: unknown, token = control.token, path = '/internal/v1/run-access', method = 'POST', headers: Record<string, string> = {}) => fetch(origin + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: value === undefined ? undefined : JSON.stringify(value) });
  async function mint(value: c.Prepare): Promise<RunAccess> {
    const res = await raw(value); assert.equal(res.status, 200);
    const json = await res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ['admission', 'bearer', 'operation']);
    assert.equal(typeof json.bearer, 'string'); assert.match(json.bearer as string, /^agx1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const op = c.preparationOperation.parse(json.operation); assert.ok(op.state === 'applied' && op.result?.kind === 'execution');
    return { operation: op, bearer: json.bearer as string, admission: c.admission.parse(json.admission) };
  }
  function execution(access: RunAccess) {
    assert.ok(access.operation.state === 'applied' && access.operation.result?.kind === 'execution');
    const ref = access.operation.result.executionRef;
    return { ref, client: createExecutionClient({ role: 'execution', origin, token: access.bearer, bufferBytes: 4096 }) };
  }
  async function request(access: RunAccess) {
    const { ref, client } = execution(access), requestId = randomUUID();
    const result = await client.request(ref, { requestId, admission: access.admission,
      body: Buffer.from(JSON.stringify({ model: profile.model, stream: true, store: false, service_tier: 'default', input: 'synthetic fixture' })) });
    assert.equal(result.kind, 'stream');
    if (result.kind === 'stream') { const reader = result.body.getReader(); while (!(await reader.read()).done) {} }
    assert.equal((await client.status(ref, requestId)).effect, 'completed');
  }
  async function stop() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  async function restart() {
    await stop();
    // Stable signing configuration keeps durable execution locators across restart.
    server = createFacade({ ...options, bearers: new FacadeBearers([{ ...control,
      ownerRefs: ['workspace-fixture'], profileIds: [profile.profile], limits: { ...limits } }]),
      profiles: [{ dto: { profileId: profile.profile, protocol: 'openai-responses', modelIds: [profile.model], authKinds: ['api_key'] }, maxOutputTokens: 1000 }] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    origin = 'http://127.0.0.1:' + address.port;
  }
  return { context, kernel, management, account, accountRef, control, otherOwner, otherConsumer, managementGrant,
    safeProfile, server, options, input, raw, mint, request, execution, stats: () => ({ transportCalls, entries }),
    count: async () => Number((await pool.query('SELECT count(*) AS n FROM ag_kernel.executions WHERE consumer=$1', [context.consumerId])).rows[0].n),
    restart, stop };
}
async function denied(response: Response, statuses = [403]) {
  assert.ok(statuses.includes(response.status));
  const error = c.safeError.parse(await response.json());
  assert.equal(error.effect, 'not_dispatched'); return error;
}

// Red if execution/management bearer is promoted to control, body chooses a
// consumer, or configured consumer/owner/profile/limit/deadline bounds are ignored.
test('HTTP control requires distinct configured consumer authority before any provider entry', async () => {
  const f = await fixture(); try {
    const value = f.input(), granted = await f.mint(value);
    await denied(await f.raw(f.input(), granted.bearer));
    // Red if an untyped service composer can promote a resolved execution grant
    // through the registry's exported issuer despite the HTTP role fence.
    const captured = await f.options.bearers.resolveExecution(granted.bearer, f.kernel); assert.ok(captured);
    const saved = await f.kernel.savedExecution(f.context, f.execution(granted).ref);
    assert.throws(() => f.options.bearers.upsertExecution(captured as unknown as Omit<RunControlBearer, 'token'>, saved),
      (error: unknown) => error instanceof KernelError && error.code === 'denied');
    await denied(await f.raw(f.input(), f.managementGrant.token));
    await denied(await f.raw(f.input(), f.otherConsumer.token), [403, 404]);
    await denied(await f.raw(f.input(), f.otherOwner.token));
    await denied(await f.raw({ ...f.input(), consumerId: f.context.consumerId }), [400]);
    await denied(await f.raw(f.input({ profileId: 'unapproved-profile' })));
    await denied(await f.raw(f.input({ limits: { ...limits, tokens: 101 } })));
    await denied(await f.raw(f.input({ deadline: new Date(Date.now() + 120_000).toISOString() })));
    const foreignAccount = await f.account('workspace-other');
    await denied(await f.raw(f.input({ accountRefs: [foreignAccount] })));
    await denied(await f.raw({}, f.control.token, '/v1/accounts'));
    assert.equal(await f.count(), 1); assert.deepEqual(f.stats(), { transportCalls: 0, entries: 0 });
    const publicResponse = await f.raw(undefined, granted.bearer, '/v1/executions/' + f.execution(granted).ref, 'GET');
    assert.equal(publicResponse.status, 200); c.execution.parse(await publicResponse.json());
  } finally { await f.stop(); }
});

test('explicit six-hour control admits long runs and recovers the same immutable ID tuple', async () => {
  const f = await fixture(21_600_000); try {
    const threeHours = f.input({ deadline: new Date(Date.now() + 3 * 3_600_000).toISOString() });
    const first = await f.mint(threeHours);
    assert.equal(first.operation.state, 'applied');

    const sixHours = f.input({ deadline: new Date(Date.now() + 21_600_000).toISOString() });
    const lost = await f.raw(sixHours); assert.equal(lost.status, 200); await lost.body?.cancel();
    const operation = await f.kernel.operation(f.context, sixHours.operationId);
    assert.ok(operation.executionRef);
    const original = await f.kernel.savedExecution(f.context, operation.executionRef);
    const recovered = await f.mint(sixHours), replay = await f.mint(sixHours);
    assert.deepEqual(recovered, replay);
    assert.equal(recovered.operation.state, 'applied');
    assert.ok(recovered.operation.result?.kind === 'execution');
    assert.equal(recovered.operation.result.executionRef, operation.executionRef);
    const { executionRef: _executionRef, issuerEpoch: _issuerEpoch, ...projection } = original.admission;
    assert.deepEqual(recovered.admission, projection);
    assert.deepEqual(await f.kernel.savedExecution(f.context, operation.executionRef), original);

    await denied(await f.raw(f.input({ deadline: new Date(Date.now() + 21_660_000).toISOString() })));
    assert.equal(await f.count(), 2); assert.deepEqual(f.stats(), { transportCalls: 0, entries: 0 });
  } finally { await f.stop(); }
});

test('default one-hour kernel composition still denies a long run before native', async () => {
  const f = await fixture(defaults.maxRunMs); try {
    await denied(await f.raw(f.input({ deadline: new Date(Date.now() + 2 * defaults.maxRunMs).toISOString() })));
    assert.equal(await f.count(), 0); assert.deepEqual(f.stats(), { transportCalls: 0, entries: 0 });
  } finally { await f.stop(); }
});

// Red if issuance globally replaces the registry, concurrent retries rotate a
// run's token, or closing X also retires the unrelated Y execution capability.
test('parallel run issuance and same-run retry preserve independent HTTP execution grants', async () => {
  const f = await fixture(); try {
    const x = f.input(), y = f.input();
    const [a, b, retry] = await Promise.all([f.mint(x), f.mint(y), f.mint(x)]);
    assert.deepEqual(a, retry); assert.notEqual(a.bearer, b.bearer); assert.equal(await f.count(), 2);
    await f.request(a); await f.request(b);
    const ex = f.execution(a); await ex.client.close(ex.ref, { operationId: randomUUID(), reason: 'completed' });
    await assert.rejects(f.request(a), forbidden);
    await f.request(b); assert.deepEqual(f.stats(), { transportCalls: 3, entries: 3 });
  } finally { await f.stop(); }
});

// Red if a lost prepare response repins after settings/metadata change, modified
// intent silently mints, restart changes original capability scope, or fenced
// recovery bypasses SQL dispatch, close, deadline or restore issuer denial.
test('original prepare recovery survives settings drift and preserves scoped fenced authority', async t => {
  for (const terminal of ['close', 'fence', 'reconnect', 'expiry', 'restore'] as const) await t.test(terminal, async () => {
    const f = await fixture(); try {
      const value = f.input(terminal === 'expiry' ? { deadline: new Date(Date.now() + 5000).toISOString() } : {});
      const lost = await f.raw(value); assert.equal(lost.status, 200); await lost.body?.cancel(); // Caller discarded the private reply.
      const op = await f.kernel.operation(f.context, value.operationId); assert.ok(op.executionRef);
      const original = await f.kernel.savedExecution(f.context, op.executionRef);
      const metadata = await f.management.account(f.context, f.accountRef);
      await f.management.rename(f.context, { operationId: randomUUID(), accountRef: f.accountRef, expectedRevision: metadata.revision, displayName: 'Settings drift' });
      // Mutate composition inputs; the accepted authority was already captured.
      (f.control.ownerRefs as string[])[0] = 'changed-owner';
      (f.control.profileIds as string[])[0] = 'changed-profile'; f.control.limits.tokens = 1;
      f.safeProfile.modelIds[0] = 'changed-model';
      let recovered = await f.mint(value); const replay = await f.mint(value); assert.deepEqual(recovered, replay);
      const { executionRef: _ref, issuerEpoch: _issuer, ...projection } = original.admission;
      assert.deepEqual(recovered.admission, projection);
      assert.deepEqual((await f.kernel.savedExecution(f.context, op.executionRef)).admission, original.admission);
      const changed = await f.raw({ ...value, bindingRevision: 4 }); assert.equal(changed.status, 409); c.safeError.parse(await changed.json());
      // Persist a synthetic accepted effect through the real kernel, without
      // entering HTTP transport or any native/provider fixture. Recovery may
      // observe this fact, but neither its ID nor a fresh ID may dispatch again.
      const requestId = randomUUID(), peer = f.options.enrollment;
      const accepted = await f.kernel.claim(f.context, op.executionRef, requestId, peer.worker, original.admission,
        { originRef: peer.originRef, engineIncarnation: peer.engineIncarnation, requestNonce: randomUUID() });
      assert.ok(accepted.dispatch);
      await f.kernel.effect(f.context, op.executionRef, requestId, peer.worker, 'response_started');
      await f.kernel.effect(f.context, op.executionRef, requestId, peer.worker, 'completed');
      await f.kernel.acknowledgeTransportClosed(f.context, peer.worker, accepted.dispatch.closure);
      const active = f.execution(recovered);
      assert.equal((await active.client.status(active.ref, requestId)).effect, 'completed');
      if (terminal === 'close') {
        await f.restart();
        const restarted = f.execution(recovered);
        assert.equal((await restarted.client.status(restarted.ref, requestId)).effect, 'completed');
        const reinstalled = await f.mint(value);
        assert.equal(reinstalled.bearer, recovered.bearer); assert.deepEqual(reinstalled.admission, recovered.admission);
        recovered = reinstalled;
        const e = f.execution(recovered); await e.client.close(e.ref, { operationId: randomUUID(), reason: 'completed' });
      } else if (terminal === 'fence') await f.kernel.fence(f.context, randomUUID(), value.subjectRef, value.policyRevision + 1);
      else if (terminal === 'reconnect') {
        const current = await f.management.account(f.context, f.accountRef);
        await f.management.reconnect(f.context, { operationId: randomUUID(), accountRef: f.accountRef, expectedRevision: current.revision, apiKey: randomUUID() });
      } else if (terminal === 'restore') {
        // Restore also fences rows previously closed; their original issuer
        // must not become eligible for the fenced readback issuance exception.
        const e = f.execution(recovered); await e.client.close(e.ref, { operationId: randomUUID(), reason: 'completed' });
        assert.equal((await f.kernel.savedExecution(f.context, op.executionRef)).state, 'closed');
        const freshIssuer = randomUUID();
        await f.kernel.restore(f.context, original.admission.issuerEpoch, freshIssuer);
        assert.equal(await f.kernel.issuer(f.context), freshIssuer);
        assert.equal((await f.kernel.savedExecution(f.context, op.executionRef)).state, 'fenced');
      } else await delay(Math.max(1, Date.parse(value.deadline) - Date.now() + 30));
      if (terminal === 'fence' || terminal === 'reconnect') {
        // Lose volatile grants, then recover only the immutable original scope.
        const previous = recovered;
        await f.restart();
        recovered = await f.mint(value);
        assert.equal(recovered.bearer, previous.bearer);
        assert.deepEqual(recovered.admission, projection);
        assert.deepEqual(await f.mint(value), recovered);
        const e = f.execution(recovered), saved = await f.kernel.savedExecution(f.context, e.ref);
        assert.equal(e.ref, op.executionRef); assert.equal(saved.state, 'fenced'); assert.equal(saved.dispatchAllowed, false);
        assert.equal(saved.generation, original.generation); assert.deepEqual(saved.admission, original.admission);
        const read = await f.raw(undefined, recovered.bearer, '/v1/executions/' + e.ref, 'GET');
        assert.equal(read.status, 200);
        assert.deepEqual(c.execution.parse(await read.json()), { executionRef: e.ref, accountRef: original.admission.accountRef,
          authorizationEpoch: original.admission.authorizationEpoch, profileId: original.admission.profileId,
          deadline: original.admission.expiresAt, state: 'fenced' });
        const operation = await f.raw(undefined, recovered.bearer, '/v1/operations/' + value.operationId, 'GET');
        assert.equal(operation.status, 200);
        assert.deepEqual(c.preparationOperation.parse(await operation.json()), recovered.operation);
        await denied(await f.raw(undefined, recovered.bearer, '/v1/executions/' + randomUUID(), 'GET'));
        const changedFenced = await f.raw({ ...value, bindingRevision: 4 });
        assert.equal(changedFenced.status, 409); c.safeError.parse(await changedFenced.json());
        const closeId = randomUUID(); await e.client.close(e.ref, { operationId: closeId, reason: 'cancelled' });
        assert.deepEqual(await f.kernel.savedExecution(f.context, e.ref), saved);
        const cleanup = await pool.query('SELECT execution_ref FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2', [f.context.consumerId, e.ref]);
        assert.equal(cleanup.rowCount, 1); assert.equal(cleanup.rows[0].execution_ref, e.ref);
        assert.deepEqual(await f.mint(value), recovered, 'close of fenced row retains scoped access');
      } else {
        const terminalReply = await f.raw(value); assert.equal(terminalReply.status, 403);
        const error = c.safeError.parse(await terminalReply.json());
        assert.equal(error.code, 'forbidden'); assert.equal(error.operationRef, value.operationId);
        assert.equal(error.effect, 'effect_unknown'); // Accepted original preparation survives mint denial.
      }
      const e = f.execution(recovered);
      if (terminal !== 'expiry') assert.equal((await e.client.status(e.ref, requestId)).effect, 'completed');
      for (const id of [requestId, randomUUID()]) {
        const response = await f.raw({ model: profile.model, stream: true, store: false, service_tier: 'default', input: 'synthetic fixture' },
          recovered.bearer, '/v1/executions/' + e.ref + '/requests', 'POST', { accept: 'text/event-stream',
            'x-gateway-admission': JSON.stringify(recovered.admission), 'x-gateway-request-id': id });
        const error = await denied(response); assert.equal(error.code, 'forbidden');
        assert.equal(error.requestRef, terminal === 'expiry' ? undefined : id);
      }
      assert.equal((await f.kernel.request(f.context, e.ref, requestId)).effect, 'completed');
      const final = await f.kernel.savedExecution(f.context, e.ref);
      assert.equal(final.generation, original.generation); assert.deepEqual(final.admission, original.admission);
      await assert.rejects(f.request(recovered), forbidden);
      assert.equal(await f.count(), 1); assert.deepEqual(f.stats(), { transportCalls: 0, entries: 0 });
    } finally { await f.stop(); }
  });
});
