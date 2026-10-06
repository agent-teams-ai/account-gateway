import test from 'node:test';
import assert from 'node:assert/strict';
import { strictJSON, validateResponses } from '../src/facade-ingress.ts';
import { KernelError } from '../src/domain.ts';
import type { AccountStatus, DurableKernel, ExecutionRead, NativeDispatchProof, OperationStatus, RequestStatus, SavedExecution } from '../src/domain.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { createFacade } from '../src/facade.ts';
import { IntentSecrets } from '../src/management-store.ts';
import { codexOAuthProfile } from '../src/management.ts';
import type { CandidateJournal, CandidateMapping, ManagementStore, PhysicalCandidate } from '../src/management.ts';
import { NativeFailure, NativeOAuthEnrollmentClient } from '../src/native-client.ts';
import { composeServiceControl, composeServiceNative } from '../src/service.ts';
import { openRouterProfile } from '../src/service-config.ts';
const bytes = (text: string) => Buffer.from(text);
const valid = { model: 'fixture-model', stream: true, store: false, service_tier: 'default', input: 'fixture' };
const invalid = (fn: () => unknown) => assert.throws(fn, e => e instanceof KernelError && e.code === 'invalid');
test('decoded duplicate names, malformed UTF-8 and bounded nesting deny ingress', () => {
  invalid(() => strictJSON(bytes('{"model":"a","\\u006dodel":"b"}')));
  invalid(() => strictJSON(bytes('{"outer":{"key":1,"\\u006bey":2}}')));
  invalid(() => strictJSON(new Uint8Array([0x22, 0xff, 0x22])));
  invalid(() => strictJSON(bytes('['.repeat(66) + '0' + ']'.repeat(66))));
  assert.deepEqual(strictJSON(bytes('{"\\u006bey":1,"value":"literal \\\"key\\\""}')), { key: 1, value: 'literal "key"' });
});
test('Responses policy rejects critical aliases and unsafe provider options before transport', () => {
  for (const patch of [{ store: true }, { stream: false }, { service_tier: 'priority' }, { previous_response_id: 'old' },
    { model: 'unqualified' }, { MAX_OUTPUT_TOKENS: 20 }, { '\uff33tore': false }]) {
    invalid(() => validateResponses(bytes(JSON.stringify({ ...valid, ...patch })), ['fixture-model'], 100));
  }
});
test('output cap lexical precision cannot round a fractional or exponential authority into an integer', () => {
  for (const cap of ['1.000000000000000001', '1e1', '0', '-1', 'null', '"10"', '101']) {
    invalid(() => validateResponses(bytes(JSON.stringify(valid).slice(0, -1) + ',"max_output_tokens":' + cap + '}'), ['fixture-model'], 100));
  }
  validateResponses(bytes(JSON.stringify({ ...valid, max_output_tokens: 100 })), ['fixture-model'], 100);
});
test('qualified canonical escapes and unrelated tool text preserve original request bytes', () => {
  const raw = bytes('{"\\u006dodel":"fixture-model","stream":true,"store":false,"service_tier":"default","input":[{"content":"MAX_OUTPUT_TOKENS user text"}]}');
  const before = Buffer.from(raw);
  validateResponses(raw, ['fixture-model'], 100);
  assert.deepEqual(raw, before);
});

test('SDK control numeric tokens cannot round into an accepted integer authority', () => {
  for (const token of ['1.000000000000000001', '0.0000000000000000000000000000000000000000000000000001', '1e0', '-0', '9007199254740991.1']) {
    invalid(() => strictJSON(bytes('{"policyRevision":' + token + ',"limits":{"tokens":100}}'), true));
    invalid(() => strictJSON(bytes('{"limits":{"requestBytes":' + token + '}}'), true));
  }
  assert.deepEqual(strictJSON(bytes('{"policyRevision":0,"bindingRevision":9007199254740991,"limits":{"tokens":100}}'), true),
    { policyRevision: 0, bindingRevision: 9007199254740991, limits: { tokens: 100 } });
  // Opaque native request values retain ordinary JSON numeric semantics.
  const raw = bytes(JSON.stringify({ ...valid, temperature: 0.25, input: [{ user_value: 1.5 }] }));
  validateResponses(raw, ['fixture-model'], 100);
  assert.equal((strictJSON(raw) as { temperature: number }).temperature, 0.25);
});

// Source boundary fixtures have test-owned committed state and real HTTP hops.
// They qualify neither SQL transactions nor Go middleware/provider transport.
async function sourceHTTP(oauth: boolean) {
  const consumerId = 'source-consumer', worker = randomUUID(), issuer = randomUUID();
  const context = { consumerId }, enrollment = { originRef: 'source-origin', engineIncarnation: randomUUID(), worker };
  const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 100 };
  const profile = { profile: 'openai-responses-apikey-v1', baseURL: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-flash',
    qualificationRef: 'source-mimo', limits, providerTokenUpperBound: 1000 };
  const secondProfile = { ...openRouterProfile, qualificationRef: 'source-openrouter', providerTokenUpperBound: 2000,
    limits: { requests: 2, concurrency: 1, requestBytes: 2048, outputBytes: 4096, tokens: 50 } };
  const consumer = { consumerId, managementCredential: 'source-native-management', executionCredential: 'source-native-execution',
    cleanupCredential: 'source-native-cleanup', callbackCredential: 'source-native-callback' };
  const accounts = new Map<string, AccountStatus>(), operations = new Map<string, OperationStatus>();
  const preparationIntents = new Map<string, string>();
  const journals = new Map<string, CandidateJournal>(), mappings = new Map<string, CandidateMapping>();
  const executions = new Map<string, SavedExecution>(), requests = new Map<string, RequestStatus>(), proofs = new Map<string, NativeDispatchProof>();
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32));
  const staged = new Map<string, string>();
  const scopeKey = (c: { consumerId: string }, id: string) => JSON.stringify([c.consumerId, id]);
  const missing = (): never => { throw new KernelError('unknown'); };
  const kernel: DurableKernel & ExecutionRead = {
    issuer: async () => issuer, heartbeat: async () => {}, reconcile: async () => {},
    account: async (c, id) => accounts.get(scopeKey(c, id)) ?? missing(),
    operation: async (c, id) => operations.get(scopeKey(c, id)) ?? missing(),
    accounts: async c => ({ accounts: [...accounts.values()].filter(a => accounts.has(scopeKey(c, a.accountRef))) }),
    async beginAccount(c, intent) {
      const key = scopeKey(c, intent.operationId), old = operations.get(key); if (old) return old;
      if (intent.kind !== 'create' || !intent.ownerRef || !intent.profile) return missing();
      const accountRef = randomUUID();
      accounts.set(scopeKey(c, accountRef), { accountRef, ownerRef: intent.ownerRef, profile: intent.profile,
        displayName: intent.displayName!, state: 'staging', revision: 1, epoch: 1 });
      const op: OperationStatus = { operationRef: intent.operationId, accountRef, state: 'pending' };
      operations.set(key, op); return op;
    },
    async startCandidate(c, id) {
      const op = await kernel.operation(c, id), account = await kernel.account(c, op.accountRef!);
      return { operationRef: id, candidate: randomUUID(), profile: account.profile };
    },
    async acknowledgeCandidate(c, id) {
      const op = await kernel.operation(c, id), account = await kernel.account(c, op.accountRef!);
      account.state = 'active'; op.state = 'applied'; op.revision = 1; op.epoch = 1; return op;
    },
    async unknownCandidate(c, id) { const op = await kernel.operation(c, id); op.state = 'unknown'; return op; },
    async prepare(c, approval) {
      const key = scopeKey(c, approval.operationId), old = operations.get(key);
      if (old) {
        if (preparationIntents.get(key) !== approval.intentDigest) throw new KernelError('conflict');
        return old;
      }
      const account = await kernel.account(c, approval.permittedAccounts[0]);
      const mapping = [...mappings.values()].find(m => m.consumerId === c.consumerId && m.accountRef === account.accountRef);
      if (!mapping || account.state !== 'active') return missing();
      const executionRef = randomUUID(), deadline = approval.deadline.toISOString();
      const saved: SavedExecution = { generation: mapping.generation, state: 'open', dispatchAllowed: true, admission: {
        executionRef, issuerEpoch: issuer, invocationRef: approval.invocationRef, attemptRef: approval.attemptRef,
        accountRef: account.accountRef, authorizationEpoch: account.epoch, subjectRef: approval.policySubject,
        policyRevision: approval.policyRevision, bindingRevision: approval.bindingRevision, profileId: approval.profile,
        expiresAt: deadline, limits: { ...approval.limits } } };
      executions.set(scopeKey(c, executionRef), saved);
      const op: OperationStatus = { operationRef: approval.operationId, executionRef, accountRef: account.accountRef, deadline, epoch: account.epoch, state: 'applied' };
      preparationIntents.set(key, approval.intentDigest);
      operations.set(key, op); return op;
    },
    savedExecution: async (c, id) => executions.get(scopeKey(c, id)) ?? missing(),
    currentWorkerLease: async () => new Date(Date.now() + 30_000).toISOString(),
    request: async (c, ref, id) => requests.get(scopeKey(c, ref + ':' + id)) ?? missing(),
    requestProof: async (c, ref, id) => proofs.get(scopeKey(c, ref + ':' + id)),
    async claim(c, ref, id, w, admission, reservation) {
      const key = scopeKey(c, ref + ':' + id), old = requests.get(key); if (old) return { status: old };
      const saved = await kernel.savedExecution(c, ref), mapping = mappings.get(scopeKey(c, saved.generation))!;
      const status: RequestStatus = { requestRef: id, effect: 'dispatch_started' };
      const closure = { executionRef: ref, requestRef: id, worker: w, token: randomUUID(), native: { ...reservation, generation: saved.generation } };
      requests.set(key, status); proofs.set(key, closure);
      return { status, dispatch: { descriptor: mapping.descriptor, executionRef: ref, requestRef: id, closure,
        limits: admission.limits, deadline: admission.expiresAt } };
    },
    async effect(c, ref, id, _w, effect) { const status = await kernel.request(c, ref, id); status.effect = effect; return status; },
    acknowledgeTransportClosed: async () => {},
    execution: async (c, id) => { const s = await kernel.savedExecution(c, id); return { executionRef: id,
      accountRef: s.admission.accountRef, epoch: s.admission.authorizationEpoch, state: s.state, deadline: s.admission.expiresAt }; },
    async close(c, operationId, executionRef) {
      const saved = await kernel.savedExecution(c, executionRef);
      executions.set(scopeKey(c, executionRef), { ...saved, state: 'closed', dispatchAllowed: false });
      const op: OperationStatus = { operationRef: operationId, executionRef, state: 'applied' };
      operations.set(scopeKey(c, operationId), op); return op;
    },
    currentCleanupLease: missing, rejectBeforeDispatch: missing, fence: missing,
    restore: missing, claimCleanup: missing, cleanupTransports: missing, settleCleanup: missing,
  };
  const store: ManagementStore = {
    stage: async (s, key) => { staged.set(scopeKey(s, s.operationId), key); return true; },
    async journal(s, generation, w, p) {
      const j = Object.freeze({ ...s, generation, worker: w, profile: Object.freeze({ ...p }) });
      // This method resolves only after this fixture's committed publication.
      journals.set(scopeKey(s, s.operationId), j); return j;
    },
    readJournal: async (c, id) => journals.get(scopeKey(c, id)),
    credential: async s => staged.get(scopeKey(s, s.operationId)), eraseIntent: async s => { staged.delete(scopeKey(s, s.operationId)); },
    saveMapping: async m => { mappings.set(scopeKey(m, m.generation), m); },
    mapping: async (c, id) => mappings.get(scopeKey(c, id)), cleanupAllowed: async () => false, expire: async () => [],
  };
  const nativeRows = new Map<string, { descriptor: Record<string, unknown>; state: string }>();
  const seen: { path: string; tuple: Record<string, unknown> }[] = [], forwarded: Record<string, unknown>[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  let callbackOrigin = '', begins = 0, bodyOwner: string | undefined, descriptorReply: unknown;
  let descriptorMode: 'normal' | 'redirect' | 'overflow' | 'headers' | 'utf8' | 'timeout' = 'normal';
  const callback = async (route: string, body: unknown, token = consumer.callbackCredential) => fetch(callbackOrigin + '/private/native/v1/' + route,
    { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  const peer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const tuple = chunks.length ? strictJSON(Buffer.concat(chunks)) as Record<string, unknown> : {};
      const path = req.url!; seen.push({ path: req.method + ' ' + path, tuple });
      const reply = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path.startsWith('/private/native/v1/oauth/connect')) {
        assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ' + consumer.managementCredential);
        assert.deepEqual(Object.keys(tuple).sort(), ['account_ref','generation','operation','owner_ref']);
        const grant = await callback('oauth-owner-authority', { consumerId, operationId: tuple.operation,
          accountRef: tuple.account_ref, generation: tuple.generation });
        if (grant.status !== 200) { reply({ code: 'denied' }, 403); return; }
        const owner = await grant.json() as { ok: true; ownerRef: string };
        if (owner.ownerRef !== (bodyOwner ?? tuple.owner_ref)) { reply({ code: 'denied' }, 403); return; }
        if (path.endsWith('/descriptor')) {
          if (descriptorMode === 'redirect') { res.writeHead(307, { location: '/escaped' }); res.end(); return; }
          if (descriptorMode === 'overflow') { res.end(Buffer.alloc(65_537)); return; }
          if (descriptorMode === 'headers') { for (let i = 0; i < 65; i++) res.setHeader('x-fixture-' + i, 'a'); }
          if (descriptorMode === 'utf8') { res.end(Buffer.from([0xff])); return; }
          if (descriptorMode === 'timeout') return;
          reply(descriptorReply ?? { operation: tuple.operation, account_ref: tuple.account_ref, state: 'staged', qualification: 'pending' }); return;
        }
        if (path === '/private/native/v1/oauth/connect') begins++;
        reply({ operation: tuple.operation, account_ref: tuple.account_ref, state: 'completed' }); return;
      }
      if (path === '/private/native/v1/candidates' && req.method === 'POST') {
        const p = [profile, secondProfile].find(p => p.profile === tuple.profile)!;
        assert.ok(p); assert.equal(req.headers.authorization, 'Bearer ' + consumer.managementCredential);
        assert.equal(tuple.api_key, 'fixture-write-only');
        nativeRows.set(tuple.generation as string, { state: 'inactive', descriptor: { generation: tuple.generation,
          account_id: nativeRows.size + 1, created_at: '2026-10-06T01:02:03.123456789Z', profile: p.profile, base_url: p.baseURL, model: p.model } });
        reply({ ok: true }); return;
      }
      if (path.startsWith('/private/native/v1/candidates/')) {
        const row = nativeRows.get(path.split('/').at(-1)!)!; assert.ok(row);
        if (req.method === 'PUT') { assert.deepEqual(tuple.descriptor, row.descriptor); row.state = tuple.state as string; }
        reply({ ...row, name: 'Fixture', group_free: true, schedulable: false, probes_enabled: false }); return;
      }
      if (path === '/private/native/v1/transports') {
        assert.equal(req.headers.authorization, 'Bearer ' + consumer.executionCredential);
        const { payload, ...admit } = tuple;
        const d = tuple.descriptor as Record<string, unknown>, generation = d.generation as string;
        const p = [profile, secondProfile].find(p => p.profile === d.profile)!;
        assert.equal(d.base_url, p.baseURL); assert.equal(d.model, p.model);
        const native = { ...enrollment, requestNonce: randomUUID(), generation };
        const nativeBinding = { originRef: native.originRef, engineIncarnation: native.engineIncarnation, requestNonce: native.requestNonce, generation };
        const result = await callback('admit', { ...admit, consumerId, native: nativeBinding });
        assert.equal(result.status, 200);
        const permit = await result.json() as { dispatch: { closure: NativeDispatchProof } };
        assert.ok(permit.dispatch);
        forwarded.push({ profile: d.profile, baseURL: d.base_url, body: payload });
        const proof = permit.dispatch.closure;
        receipts.set(proof.requestRef, { consumerId, executionRef: proof.executionRef, requestRef: proof.requestRef,
          native: nativeBinding, proof, phase: 'closed', effect: 'completed', sealed: true, acknowledged: false,
          lifetime: { entered: true, contextDone: true, forwardingReturned: true, bodyKnown: true, bodyClosed: true,
            closeFailed: false, completed: true, sealed: true } });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-gateway-request-ref': proof.requestRef });
        res.end('data: {"type":"response.completed","fixture":"tools-and-final"}\n\n'); return;
      }
      if (path === '/private/native/v1/transports/read-owner' || path === '/private/native/v1/transports/ack-owner') {
        const proof = tuple.proof as NativeDispatchProof, r = receipts.get(proof.requestRef)!; assert.ok(r);
        if (path.endsWith('/ack-owner')) {
          const ack = await callback('closure-ack', { consumerId, proof, receipt: r }); assert.equal(ack.status, 200);
          assert.deepEqual(await ack.json(), { ok: true }); r.acknowledged = true;
        }
        reply(r, 202); return;
      }
      reply({ code: 'denied' }, 404);
    })().catch(() => { res.destroy(); });
  });
  const servers: Server[] = [peer];
  const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const a = server.address(); assert.ok(a && typeof a === 'object'); return 'http://127.0.0.1:' + a.port; };
  const origin = await listen(peer);
  const selected = oauth ? codexOAuthProfile.profile : profile.profile;
  const preparation = { accountRefs: [], subjectRef: 'source-subject', policyRevision: 1, bindingRevision: 1,
    profileId: selected, limits: secondProfile.limits, maxRunMs: 20_000 };
  const managementGrant = { token: 'source-public-management', role: 'management' as const, consumerId,
    ownerRefs: ['owner-one', 'owner-two'], preparation };
  const bearers = oauth ? [managementGrant] : [managementGrant,
    { token: 'source-public-run', role: 'run-control' as const, consumerId, ownerRefs: managementGrant.ownerRefs,
      profileIds: [profile.profile, secondProfile.profile], limits: secondProfile.limits, maxRunMs: 20_000 }];
  const cfg = { native: { executable: '/unused', sha256: 'unused', bootstrapFile: '/unused', authorityDir: '/unused', origin, originRef: enrollment.originRef, uid: 1, gid: 1 },
    consumer, profile, secondProfile, bearers, ...(oauth ? { oauthEnrollment: { enabled: true as const,
      profile: 'openai-codex-oauth-responses-v1' as const, modelScope: ['gpt-6.1-sol'] as const,
      qualificationRef: 'source-codex', limits, providerTokenUpperBound: 1000 } } : {}) };
  const closeServers = async () => { for (const s of servers.reverse()) {
    s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } };
  try {
  const control = composeServiceControl(cfg, kernel, store, custody, worker);
  const { authority, transport } = composeServiceNative(cfg, control, kernel, store, enrollment);
  const callbacks = authority.createServer(); servers.push(callbacks); callbackOrigin = await listen(callbacks);
  const facade = createFacade({ kernel, store, management: control.management, bearers: control.bearers,
    profiles: control.catalog, enrollment, transport, intentHmacKey: randomBytes(32), ingressBytes: 4096 });
  servers.push(facade); const facadeOrigin = await listen(facade);
  const publicCall = (path: string, body?: unknown, token = managementGrant.token, headers: Record<string, string> = {}) =>
    fetch(facadeOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token,
      'content-type': 'application/json', accept: path.includes('/requests') ? 'text/event-stream' : 'application/json',
      ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { context, consumer, control, authority, cfg, kernel, store, journals, mappings, accounts, operations, executions, requests,
    publicCall, callback, seen, forwarded, profile, secondProfile, begins: () => begins,
    owner: (value: string | undefined) => { bodyOwner = value; },
    descriptor: (value: unknown, mode: typeof descriptorMode = 'normal') => { descriptorReply = value; descriptorMode = mode; },
    close: closeServers,
    origin, callbackOrigin, facade, facadeOrigin, nativeRows, scopeKey };
  } catch (error) { await closeServers(); throw error; }
}

test('source HTTP: current management fences monotonically for its exact subject while prepare stays pinned', async () => {
  const f = await sourceHTTP(false);
  try {
    const initial = f.cfg.bearers.find(b => b.role === 'management');
    assert.ok(initial && initial.role === 'management');
    const accountRef = randomUUID();
    f.accounts.set(f.scopeKey(f.context, accountRef), { accountRef, ownerRef: 'owner-one',
      profile: initial.preparation.profileId, displayName: 'GX fixture', state: 'active', revision: 1, epoch: 1 });
    const gx = { ...initial, ownerRefs: ['owner-one'], preparation: { ...initial.preparation,
      accountRefs: [accountRef], subjectRef: 'source-subject-GX', policyRevision: 2 } };
    // X and Y share the canonical account owner but have distinct binding subjects.
    const gy = { ...gx, token: 'source-public-management-Y', preparation: { ...gx.preparation, subjectRef: 'source-subject-Y' } };
    const entries = [gx, gy, ...f.cfg.bearers.filter(b => b.role === 'run-control')];
    f.control.bearers.replace(entries);
    // Controlled kernel records only facade authorization; it certifies no SQL fence/closure behavior.
    const calls: Parameters<DurableKernel['fence']>[] = [];
    f.kernel.fence = async (...args) => {
      calls.push(args); return { operationRef: args[1], state: 'applied' };
    };
    let prepares = 0;
    f.kernel.prepare = async () => { prepares++; throw new KernelError('denied'); };
    const input = { operationId: randomUUID(), subjectRef: gx.preparation.subjectRef, revision: 3 };
    const applied = await f.publicCall('/v1/policy-fences', input, gx.token);
    assert.deepEqual({ status: applied.status, calls: calls.length }, { status: 200, calls: 1 });
    assert.deepEqual(await applied.json(), { operationRef: input.operationId, state: 'applied' });
    assert.deepEqual(calls, [[f.context, input.operationId, gx.preparation.subjectRef, 3]]);
    const denied = async (body: typeof input, token = gx.token) => {
      const response = await f.publicCall('/v1/policy-fences', body, token);
      assert.equal(response.status, 403);
      const error = await response.json() as { code: string; effect: string };
      assert.equal(error.code, 'forbidden'); assert.equal(error.effect, 'not_dispatched');
      assert.equal(calls.length, 1);
    };
    await denied({ ...input, operationId: randomUUID(), subjectRef: gy.preparation.subjectRef });
    await denied({ ...input, operationId: randomUUID(), revision: 1 });
    await denied({ ...input, operationId: randomUUID() }, gy.token);
    await denied({ ...input, operationId: randomUUID() }, 'source-public-run');
    const prepare = await f.publicCall('/v1/executions', { operationId: randomUUID(),
      invocationRef: 'source-invocation-GX', attemptRef: 'attempt', accountRefs: [accountRef],
      profileId: gx.preparation.profileId, subjectRef: gx.preparation.subjectRef, policyRevision: 3,
      bindingRevision: gx.preparation.bindingRevision, limits: gx.preparation.limits,
      deadline: new Date(Date.now() + 10_000).toISOString() }, gx.token);
    assert.equal(prepare.status, 403);
    assert.equal((await prepare.json() as { effect: string }).effect, 'not_dispatched');
    assert.equal(prepares, 0); assert.equal(calls.length, 1);
    // Send headers alone so the real handler captures GX and awaits its body.
    // Replacing even the same token retires that captured immutable capability.
    const captured = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { f.facade.off('request', onRequest); reject(error); };
      const onRequest = () => { f.facade.off('error', onError); resolve(); };
      f.facade.once('request', onRequest); f.facade.once('error', onError);
    });
    let stale: ReturnType<typeof request> | undefined;
    const staleResponse = new Promise<number>((resolve, reject) => {
      stale = request(f.facadeOrigin + '/v1/policy-fences', { method: 'POST', headers: {
        authorization: 'Bearer ' + gx.token, 'content-type': 'application/json', accept: 'application/json',
        'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!); });
      stale.on('error', reject); stale.flushHeaders();
    });
    try {
      await captured;
      f.control.bearers.replace(entries);
      stale!.end(JSON.stringify({ ...input, operationId: randomUUID() }));
      assert.equal(await staleResponse, 403); assert.equal(calls.length, 1);
    } finally { stale?.destroy(); }
    const replacement = { ...gx, token: 'source-public-management-replaced' };
    f.control.bearers.replace([replacement, gy]);
    const retired = await f.publicCall('/v1/policy-fences', { ...input, operationId: randomUUID() }, gx.token);
    assert.equal(retired.status, 401);
    assert.equal((await retired.json() as { effect: string }).effect, 'not_dispatched');
    assert.equal(calls.length, 1);
    const currentInput = { ...input, operationId: randomUUID() };
    const current = await f.publicCall('/v1/policy-fences', currentInput, replacement.token);
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), { operationRef: currentInput.operationId, state: 'applied' });
    assert.deepEqual(calls, [[f.context, input.operationId, gx.preparation.subjectRef, 3],
      [f.context, currentInput.operationId, gx.preparation.subjectRef, 3]]);
    assert.equal(f.seen.length, 0); assert.equal(f.forwarded.length, 0);
  } finally { await f.close(); }
});

test('source HTTP: owner lookup resolves two original pending journals, revocation and foreign selectors deny', async () => {
  const f = await sourceHTTP(true);
  try {
    const ids = [randomUUID(), randomUUID()];
    for (const [i, operationId] of ids.entries()) {
      const response = await f.publicCall('/v1/accounts/oauth/begin', { operationId, ownerRef: 'owner-' + (i ? 'two' : 'one'),
        profileId: codexOAuthProfile.profile, displayName: 'Source fixture' });
      assert.equal(response.status, 202); const safe = await response.json() as { operation: { state: string } };
      assert.equal(safe.operation.state, 'pending');
    }
    assert.equal(f.begins(), 2); assert.equal(f.mappings.size, 0);
    const js = ids.map(id => f.journals.get(f.scopeKey(f.context, id))!);
    assert.equal(js[0].ownerRef, 'owner-one'); assert.equal(js[1].ownerRef, 'owner-two');
    const lookup = (j: CandidateJournal) => ({ consumerId: j.consumerId, operationId: j.operationId, accountRef: j.accountRef, generation: j.generation });
    for (const j of js) {
      const r = await f.callback('oauth-owner-authority', lookup(j)); assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, ownerRef: j.ownerRef });
      const before = f.seen.length, read = await f.publicCall('/v1/operations/' + j.operationId); assert.equal(read.status, 200);
      assert.equal((await read.json() as { state: string }).state, 'pending');
      assert.deepEqual(f.seen.slice(before).map(s => s.tuple), Array(2).fill({ operation: j.operationId, owner_ref: j.ownerRef,
        account_ref: j.accountRef, generation: j.generation }));
    }
    for (const patch of [{ consumerId: 'foreign' }, { operationId: randomUUID() }, { operationId: js[1].operationId },
      { generation: js[1].generation }, { accountRef: js[1].accountRef }, { ownerRef: js[1].ownerRef }, { generation: js[0].generation.toUpperCase() }]) {
      assert.equal((await f.callback('oauth-owner-authority', { ...lookup(js[0]), ...patch })).status, 403);
    }
    assert.equal((await f.callback('oauth-owner-authority', lookup(js[0]), f.consumer.managementCredential)).status, 403);
    const rawLookup = (body: string) => fetch(f.callbackOrigin + '/private/native/v1/oauth-owner-authority', {
      method: 'POST', headers: { authorization: 'Bearer ' + f.consumer.callbackCredential, 'content-type': 'application/json' }, body });
    assert.equal((await rawLookup(JSON.stringify(lookup(js[0])).slice(0, -1) +
      ',"\\u0067eneration":"' + js[1].generation + '"}')).status, 403);
    await assert.rejects(rawLookup(JSON.stringify({ ...lookup(js[0]), operationId: 'x'.repeat(1025) })));
    const originalOp = f.operations.get(f.scopeKey(f.context, js[0].operationId))!;
    f.operations.set(f.scopeKey(f.context, js[0].operationId), { ...originalOp, accountRef: js[1].accountRef });
    assert.equal((await f.callback('oauth-owner-authority', lookup(js[0]))).status, 403);
    f.operations.set(f.scopeKey(f.context, js[0].operationId), originalOp);
    const originalJournal = js[0];
    f.journals.set(f.scopeKey(f.context, js[0].operationId), { ...originalJournal, ownerRef: js[1].ownerRef });
    assert.equal((await f.callback('oauth-owner-authority', lookup(js[0]))).status, 403);
    f.journals.set(f.scopeKey(f.context, js[0].operationId), originalJournal);
    const tuple = { ...js[0], ownerRef: js[1].ownerRef };
    const fixed = new NativeOAuthEnrollmentClient({ origin: f.origin, consumerId: f.context.consumerId,
      controlCredential: f.consumer.managementCredential, ownerRef: js[0].ownerRef });
    const seen = f.seen.length;
    await assert.rejects(fixed.begin(tuple), e => e instanceof NativeFailure && e.code === 'denied'); assert.equal(f.seen.length, seen);
    f.owner(js[1].ownerRef);
    await assert.rejects(fixed.begin(js[0]));
    assert.equal(f.begins(), 2); f.owner(undefined);
    const physical: PhysicalCandidate = { generation: js[0].generation, nativePhysicalIdentity: js[0].generation, nativeId: 1,
      createdAt: '2026-10-06T01:02:03.123456789Z', ...codexOAuthProfile };
    f.mappings.set(f.scopeKey(f.context, js[0].generation), { ...js[0], descriptor: { ...physical, nativePhysicalIdentity: randomUUID() } });
    assert.equal((await f.callback('oauth-owner-authority', lookup(js[0]))).status, 403);
    f.mappings.delete(f.scopeKey(f.context, js[0].generation));
    f.control.bearers.replace([]);
    assert.equal((await f.callback('oauth-owner-authority', lookup(js[0]))).status, 403);
    await assert.rejects(fixed.begin(js[0])); assert.equal(f.begins(), 2);
  } finally { await f.close(); }
});

test('source HTTP: strict fixed POST descriptor readback keeps custody pending and pins physical birth', async () => {
  const f = await sourceHTTP(true);
  try {
    const operationId = randomUUID();
    const begun = await f.publicCall('/v1/accounts/oauth/begin', { operationId, ownerRef: 'owner-one', profileId: codexOAuthProfile.profile, displayName: 'Fixture' });
    assert.equal(begun.status, 202);
    const j = f.journals.get(f.scopeKey(f.context, operationId))!;
    const native = { account_id: 1, generation: j.generation, created_at: '2026-10-06T01:02:03.123456789Z',
      profile: codexOAuthProfile.profile, base_url: codexOAuthProfile.baseURL, model: codexOAuthProfile.model };
    const reply = { operation: operationId, account_ref: j.accountRef, state: 'qualified', qualification: 'qualified', native };
    const client = new NativeOAuthEnrollmentClient({ origin: f.origin, consumerId: j.consumerId,
      controlCredential: f.consumer.managementCredential, ownerRef: j.ownerRef, deadlineMs: 75 });
    f.descriptor(reply); const d = await client.describe(j); assert.equal(d.state, 'qualified');
    if (d.state === 'qualified') { assert.equal(d.native.createdAt, native.created_at); assert.equal(d.native.nativePhysicalIdentity, j.generation); }
    for (const value of [{ ...reply, operation: randomUUID() }, { ...reply, account_ref: randomUUID() }, { ...reply, token: 'forbidden' },
      { ...reply, state: 'staged', qualification: 'pending' }, { ...reply, native: { ...native, generation: randomUUID() } },
      { ...reply, native: { ...native, profile: f.secondProfile.profile } }, { ...reply, native: { ...native, base_url: f.secondProfile.baseURL } },
      { ...reply, native: { ...native, model: f.secondProfile.model } }, { ...reply, native: { ...native, account_id: Number.MAX_SAFE_INTEGER + 1 } }]) {
      f.descriptor(value); await assert.rejects(client.describe(j), e => e instanceof NativeFailure && e.code === 'invalid_readback');
    }
    for (const mode of ['redirect','overflow','headers','utf8','timeout'] as const) {
      f.descriptor(undefined, mode); await assert.rejects(client.describe(j), e => e instanceof NativeFailure &&
        (mode !== 'headers' || (e.code === 'bounded' && e.classification === 'uncertain')), mode);
    }
    assert.equal(f.seen.some(s => s.path.includes('/escaped')), false);
    f.descriptor(undefined);
    const pending = await f.publicCall('/v1/operations/' + operationId); assert.equal(pending.status, 200);
    assert.equal((await pending.json() as { state: string }).state, 'pending');
    assert.equal(f.mappings.size, 0); assert.equal((await f.kernel.account(f.context, j.accountRef)).state, 'staging');
    const before = f.seen.length;
    assert.equal((await f.publicCall('/v1/operations/' + operationId + '?owner=owner-two')).status, 400);
    assert.equal(f.seen.length, before);
    // Separate protected descriptor and exact inert route evidence are both
    // required before the existing mapping/activation/kernel ACK sequence.
    f.descriptor(reply); f.nativeRows.set(j.generation, { descriptor: native, state: 'inactive' });
    const qualified = await f.publicCall('/v1/operations/' + operationId); assert.equal(qualified.status, 200);
    assert.equal((await qualified.json() as { state: string }).state, 'applied');
    assert.equal((await f.kernel.account(f.context, j.accountRef)).state, 'active');
    assert.equal((await f.store.mapping(f.context, j.generation))?.descriptor.createdAt, native.created_at);
    const secondId = randomUUID();
    f.descriptor(undefined);
    assert.equal((await f.publicCall('/v1/accounts/oauth/begin', { operationId: secondId, ownerRef: 'owner-two',
      profileId: codexOAuthProfile.profile, displayName: 'Fixture' })).status, 202);
    const second = f.journals.get(f.scopeKey(f.context, secondId))!;
    const secondNative = { ...native, account_id: 2, generation: second.generation };
    f.descriptor({ ...reply, operation: secondId, account_ref: second.accountRef, native: secondNative });
    f.nativeRows.set(second.generation, { descriptor: { ...secondNative, created_at: '2026-10-06T01:02:03.123456788Z' }, state: 'inactive' });
    const mismatched = await f.publicCall('/v1/operations/' + secondId); assert.equal(mismatched.status, 200);
    assert.equal((await mismatched.json() as { state: string }).state, 'unknown');
    assert.equal(await f.store.mapping(f.context, second.generation), undefined);
  } finally { await f.close(); }
});

test('source HTTP: same fenced original remints only scoped readback and close, never dispatch', async () => {
  const f = await sourceHTTP(false);
  try {
    const creationId = randomUUID();
    const created = await f.publicCall('/v1/accounts', { operationId: creationId, ownerRef: 'owner-one',
      profileId: f.secondProfile.profile, displayName: 'Fenced fixture', credential: { kind: 'api_key', value: 'fixture-write-only' } });
    assert.equal(created.status, 200);
    const accountRef = f.journals.get(f.scopeKey(f.context, creationId))!.accountRef;
    const input = { operationId: randomUUID(), invocationRef: 'source-fenced-original', attemptRef: 'attempt', accountRefs: [accountRef],
      profileId: f.secondProfile.profile, subjectRef: 'source-subject', policyRevision: 1, bindingRevision: 1,
      limits: f.secondProfile.limits, deadline: new Date(Date.now() + 10_000).toISOString() };
    const mint = () => f.publicCall('/internal/v1/run-access', input, 'source-public-run');
    const first = await mint(); assert.equal(first.status, 200);
    type Access = { operation: { operationRef: string; result: { executionRef: string; state: string } };
      bearer: string; admission: Record<string, unknown> };
    const run = await first.json() as Access, ref = run.operation.result.executionRef;
    const executionKey = f.scopeKey(f.context, ref), original = await f.kernel.savedExecution(f.context, ref);
    const requestId = randomUUID(), requestKey = f.scopeKey(f.context, ref + ':' + requestId);
    // Committed accepted effect after fencing/occupancy closure; SQL closure is
    // independently qualified elsewhere. This source fixture makes no native call.
    f.requests.set(requestKey, { requestRef: requestId, effect: 'effect_unknown' });
    const fenced: SavedExecution = { ...original, state: 'fenced', dispatchAllowed: false };
    f.executions.set(executionKey, fenced);
    const nativeCalls = f.seen.length, forwarded = f.forwarded.length;
    const denyDispatch = async (bearer: string, admission: Record<string, unknown>) => {
      for (const id of [requestId, randomUUID()]) {
        const response = await f.publicCall('/v1/executions/' + ref + '/requests', {
          model: f.secondProfile.model, stream: true, store: false, service_tier: 'default', input: 'fixture' }, bearer,
        { 'x-gateway-admission': JSON.stringify(admission), 'x-gateway-request-id': id });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { effect: string }).effect, 'not_dispatched');
        assert.equal(f.seen.length, nativeCalls); assert.equal(f.forwarded.length, forwarded);
      }
      assert.deepEqual(f.requests.get(requestKey), { requestRef: requestId, effect: 'effect_unknown' });
      assert.equal(f.requests.size, 1);
    };
    await denyDispatch(run.bearer, run.admission);
    const retained = await mint(); assert.equal(retained.status, 200, 'same fenced original must retain scoped access');
    assert.equal((await retained.json() as Access).bearer, run.bearer);
    // Lose the issued execution mapping while keeping current configured policy.
    f.control.bearers.replace(f.cfg.bearers);
    f.kernel.issuer = async () => { throw new Error('same original must retain its persisted issuer'); };
    const remint = await mint(); assert.equal(remint.status, 200, 'same fenced original must receive scoped access');
    const scoped = await remint.json() as Access;
    assert.equal(scoped.operation.operationRef, input.operationId);
    assert.deepEqual(scoped.operation.result, { kind: 'execution', executionRef: ref, accountRef,
      authorizationEpoch: original.admission.authorizationEpoch, deadline: input.deadline, state: 'fenced' });
    assert.deepEqual(scoped.admission, run.admission); assert.notEqual(scoped.bearer, run.bearer);
    const grant = f.control.bearers.resolve(scoped.bearer);
    assert.ok(grant && grant.role === 'execution');
    assert.equal(grant.saved.generation, original.generation);
    assert.deepEqual(grant.saved.admission, original.admission);
    const repeated = await mint(); assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as Access).bearer, scoped.bearer);
    for (const path of ['/v1/executions/' + ref, '/v1/operations/' + input.operationId]) {
      const read = await f.publicCall(path, undefined, scoped.bearer);
      assert.equal(read.status, 200);
      const dto = await read.json() as { state: string; result?: { state: string } };
      assert.equal(dto.result?.state ?? dto.state, 'fenced');
    }
    const status = await f.publicCall('/v1/executions/' + ref + '/requests/' + requestId, undefined, scoped.bearer,
      { accept: 'application/json' });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { effect: string }).effect, 'effect_unknown');
    const foreign = await f.publicCall('/v1/executions/' + randomUUID(), undefined, scoped.bearer);
    assert.equal(foreign.status, 403);
    const foreignOperation = await f.publicCall('/v1/operations/' + creationId, undefined, scoped.bearer);
    assert.equal(foreignOperation.status, 403);
    await denyDispatch(scoped.bearer, scoped.admission);
    const changed = await f.publicCall('/internal/v1/run-access', { ...input, invocationRef: 'changed-intent' }, 'source-public-run');
    assert.equal(changed.status, 409);
    const prepare = f.kernel.prepare;
    // Simulate inconsistent persisted readback across the two server reads.
    for (const conflicting of [
      { ...fenced, generation: randomUUID() },
      { ...fenced, admission: { ...fenced.admission, issuerEpoch: randomUUID() } },
      { ...fenced, admission: { ...fenced.admission, authorizationEpoch: fenced.admission.authorizationEpoch + 1 } },
    ]) {
      f.control.bearers.replace(f.cfg.bearers);
      f.kernel.prepare = async (...args) => { const op = await prepare(...args); f.executions.set(executionKey, conflicting); return op; };
      assert.equal((await mint()).status, 403);
      f.executions.set(executionKey, fenced);
    }
    // Even an applied prepare cannot supply the exception without the original lookup.
    const operation = f.kernel.operation;
    f.kernel.operation = async (context, id) => { if (id === input.operationId) throw new KernelError('unknown'); return operation(context, id); };
    f.kernel.issuer = async () => original.admission.issuerEpoch;
    f.kernel.prepare = prepare;
    assert.equal((await mint()).status, 403);
    f.kernel.operation = operation;
    // Current owner authorization and captured grant replacement still deny issuance.
    const account = f.accounts.get(f.scopeKey(f.context, accountRef))!;
    account.ownerRef = 'foreign-owner'; assert.equal((await mint()).status, 403); account.ownerRef = 'owner-one';
    f.kernel.prepare = async (...args) => { const op = await prepare(...args); f.control.bearers.replace(f.cfg.bearers); return op; };
    assert.equal((await mint()).status, 403);
    f.kernel.prepare = prepare;
    f.executions.set(executionKey, { ...fenced, admission: { ...fenced.admission, expiresAt: new Date(0).toISOString() } });
    assert.equal((await mint()).status, 403, 'original expiry still denies remint');
    f.executions.set(executionKey, fenced);
    const finalAccess = await mint(); assert.equal(finalAccess.status, 200);
    const final = await finalAccess.json() as Access;
    const closeId = randomUUID(), close = await f.publicCall('/v1/executions/' + ref + '/close',
      { operationId: closeId, reason: 'cancelled' }, final.bearer);
    assert.equal(close.status, 200); assert.deepEqual(await close.json(), { operationRef: closeId, state: 'applied' });
    assert.equal((await f.kernel.savedExecution(f.context, ref)).state, 'closed');
    assert.equal((await mint()).status, 403, 'closed original is not a fenced issuance exception');
    await denyDispatch(final.bearer, final.admission);
    assert.equal(f.executions.size, 1); assert.equal(f.seen.length, nativeCalls);
  } finally { await f.close(); }
});

test('source HTTP: simultaneous finite tuples create/read/admit/forward independently and reject cross-profile authority', async () => {
  const f = await sourceHTTP(false);
  try {
    const catalog = await f.publicCall('/v1/profiles'); assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json() as { profiles: { profileId: string }[] }).profiles.map(p => p.profileId), [f.profile.profile, f.secondProfile.profile]);
    for (const [i, p] of [f.profile, f.secondProfile].entries()) {
      const token = 'source-public-management';
      const operationId = randomUUID(), response = await f.publicCall('/v1/accounts', { operationId, ownerRef: 'owner-one',
        profileId: p.profile, displayName: 'Fixture', credential: { kind: 'api_key', value: 'fixture-write-only' } }, token);
      assert.equal(response.status, 200);
      const j = f.journals.get(f.scopeKey(f.context, operationId))!, mapping = await f.store.mapping(f.context, j.generation); assert.ok(mapping);
      assert.equal(mapping.descriptor.profile, p.profile); assert.equal(mapping.descriptor.baseURL, p.baseURL); assert.equal(mapping.descriptor.model, p.model);
      const input = { operationId: randomUUID(), invocationRef: 'source-invocation-' + i, attemptRef: 'attempt', accountRefs: [j.accountRef],
        profileId: p.profile, subjectRef: 'source-subject', policyRevision: 1, bindingRevision: 1,
        limits: f.secondProfile.limits, deadline: new Date(Date.now() + 10_000).toISOString() };
      const access = await f.publicCall('/internal/v1/run-access', input, 'source-public-run'); assert.equal(access.status, 200);
      const run = await access.json() as { operation: { result: { executionRef: string } }; bearer: string; admission: Record<string, unknown> };
      const executionRef = run.operation.result.executionRef;
      const headers = { 'x-gateway-admission': JSON.stringify(run.admission), 'x-gateway-request-id': randomUUID() };
      const body = { model: p.model, stream: true, store: false, service_tier: 'default', input: [{ role: 'user', content: 'fixture tools and final' }] };
      const before = f.forwarded.length;
      const bad = await f.publicCall('/v1/executions/' + executionRef + '/requests', { ...body, model: i ? f.profile.model : f.secondProfile.model }, run.bearer, headers);
      assert.equal(bad.status, 400); assert.equal(f.forwarded.length, before);
      // Corrupt each server mapping component before a fresh POST; none may
      // borrow the other profile's descriptor or qualification/limit policy.
      for (const patch of [{ profile: { ...mapping.profile, qualificationRef: 'wrong-receipt' } },
        { descriptor: { ...mapping.descriptor, baseURL: i ? f.profile.baseURL : f.secondProfile.baseURL } },
        { descriptor: { ...mapping.descriptor, model: i ? f.profile.model : f.secondProfile.model } }]) {
        f.mappings.set(f.scopeKey(f.context, j.generation), { ...mapping, ...patch });
        const deny = await f.publicCall('/v1/executions/' + executionRef + '/requests', body, run.bearer,
          { ...headers, 'x-gateway-request-id': randomUUID() }); assert.equal(deny.status, 403); assert.equal(f.forwarded.length, before);
      }
      f.mappings.set(f.scopeKey(f.context, j.generation), mapping);
      const completed = await f.publicCall('/v1/executions/' + executionRef + '/requests', body, run.bearer, headers);
      assert.equal(completed.status, 200); assert.match(await completed.text(), /tools-and-final/);
      assert.equal(f.forwarded.length, before + 1);
      assert.deepEqual(f.forwarded.at(-1), { profile: p.profile, baseURL: p.baseURL, body });
      assert.equal((await f.kernel.request(f.context, executionRef, headers['x-gateway-request-id'])).effect, 'completed');
      const denied = await f.publicCall('/internal/v1/run-access', { ...input, operationId: randomUUID(),
        limits: { ...input.limits, tokens: p.limits.tokens + 1 } }, 'source-public-run'); assert.equal(denied.status, 403);
      const noEndpoint = await f.publicCall('/v1/accounts', { operationId: randomUUID(), ownerRef: 'owner-one', profileId: p.profile,
        displayName: 'Fixture', baseURL: p.baseURL, model: p.model, credential: { kind: 'api_key', value: 'fixture-write-only' } }, token);
      assert.equal(noEndpoint.status, 400);
    }
    assert.equal(f.forwarded.length, 2);
  } finally { await f.close(); }
});
