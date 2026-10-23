import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeOAuthEnrollmentClient } from '../src/native-client.ts';
import type { OAuthScope } from '../src/management.ts';
import { config, jsonBody, post } from '../src/native-wire.ts';
import { NativeControlAdmission, ServiceAdmission, admitNativeCallback, nativeControlCapacity,
  nativeCallbackCapacity, nativeCallbackPurpose, serviceCapacity } from '../src/service-admission.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return 'http://127.0.0.1:' + address.port;
}
async function stop(server: Server): Promise<void> {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections(); await closed;
}
function configuration(origin: string) {
  return config({ origin, enrollment: { originRef: 'control-fixture', engineIncarnation: randomUUID(),
    worker: randomUUID(), qualificationRef: 'fixture-qualified' },
  consumers: [{ consumerId: 'control-fixture', executionCredential: 'synthetic-execution-credential',
    cleanupCredential: 'synthetic-cleanup-credential', callbackCredential: 'synthetic-callback-credential' }],
  profiles: [{ profile: 'fixture', baseURL: 'https://example.invalid/v1', model: 'fixture-model',
    qualificationRef: 'fixture-qualified', requestBytes: 1024, outputBytes: 1024, tokens: 10, providerTokenUpperBound: 10 }] });
}
async function wire(origin: string, admission: NativeControlAdmission, id: string, duration = 3000, signal?: AbortSignal) {
  const hop = await post(configuration(origin), 'synthetic-execution-credential', '/wire',
    Buffer.from(JSON.stringify({ id })), signal, duration, admission);
  try { return await jsonBody(hop.response, 4096); } finally { hop.abort(); }
}

test('one shared queue bounds actual management and transport HTTP through response body closure', { timeout: 10_000 }, async () => {
  const admission = new NativeControlAdmission();
  const initial = Promise.withResolvers<void>();
  const held: { response: ServerResponse; reply: string }[] = [];
  const received = new Set<string>(); let open = false, failure: unknown;
  const peer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
      const id = body.id ?? body.operation;
      assert.equal(received.has(id), false, 'no replay'); received.add(id);
      assert.match(req.headers.authorization ?? '', /^Bearer synthetic-/);
      const reply = JSON.stringify(req.url === '/wire' ? { id } :
        { operation: body.operation, account_ref: body.account_ref, state: 'idle' });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.flushHeaders();
      if (open) res.end(reply); else held.push({ response: res, reply });
      if (received.size === nativeControlCapacity.active) initial.resolve();
    })().catch(error => { failure = error; res.destroy(); });
  });
  const origin = await listen(peer);
  const requests: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < nativeControlCapacity.active + nativeControlCapacity.waiting; i++) {
      if (i % 2) {
        const scope: OAuthScope = { consumerId: 'control-fixture', operationId: 'management-' + i,
          accountRef: randomUUID(), generation: randomUUID(), ownerRef: 'fixture-owner' };
        // Fresh scoped clients must still share the composition-owned scheduler.
        const client = new NativeOAuthEnrollmentClient({ origin, consumerId: scope.consumerId, ownerRef: scope.ownerRef,
          controlCredential: 'synthetic-management-credential', admission });
        requests.push(client.refresh(scope));
      } else requests.push(wire(origin, admission, 'transport-' + i));
    }
    await initial.promise;
    await assert.rejects(wire(origin, admission, 'overflow'));
    await delay(30);
    assert.equal(received.size, nativeControlCapacity.active, 'headers alone cannot recycle physical ownership');
    open = true; held.forEach(({ response, reply }) => response.end(reply));
    await Promise.all(requests);
    await admission.stop();
    assert.equal(received.size, nativeControlCapacity.active + nativeControlCapacity.waiting);
    assert.equal(received.has('overflow'), false);
    if (failure) throw failure;
  } finally { open = true; held.forEach(({ response, reply }) => response.end(reply)); await stop(peer); await admission.stop(); }
});

test('queued abort, queue overflow and deadline send no HTTP; queue time counts against the same wire deadline', { timeout: 10_000 }, async () => {
  const admission = new NativeControlAdmission(1, 2);
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  const received: string[] = []; let held: ServerResponse | undefined;
  const peer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const { id } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string };
      received.push(id); res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
      if (id === 'first') { held = res; first.resolve(); } else second.resolve();
    })().catch(() => res.destroy());
  });
  const origin = await listen(peer);
  const active = wire(origin, admission, 'first');
  try {
    await first.promise;
    const abort = new AbortController(), aborted = wire(origin, admission, 'aborted', 3000, abort.signal);
    const expired = wire(origin, admission, 'expired', 60);
    await assert.rejects(wire(origin, admission, 'overflow'));
    abort.abort(); await assert.rejects(aborted); await assert.rejects(expired);
    assert.deepEqual(received, ['first']);
    const start = Date.now();
    const pending = wire(origin, admission, 'second', 400);
    const rejected = assert.rejects(pending);
    await delay(250); held!.end('{}'); await active; await second.promise; await rejected;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 560, 'wire received only the remaining deadline, elapsed=' + elapsed);
    assert.deepEqual(received, ['first', 'second']);
  } finally { held?.end('{}'); await stop(peer); await active.catch(() => undefined); await admission.stop(); }
});

test('shutdown rejects queued and new controls, retaining an active HTTP socket until physical close', { timeout: 10_000 }, async () => {
  const admission = new NativeControlAdmission(1, 1), entered = Promise.withResolvers<void>();
  let received = 0;
  const peer = createServer((req, res) => {
    req.resume(); received++; res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); entered.resolve();
  });
  const origin = await listen(peer), abort = new AbortController();
  const active = wire(origin, admission, 'active', 3000, abort.signal);
  void active.catch(() => undefined);
  try {
    await entered.promise;
    const queued = wire(origin, admission, 'queued');
    let drained = false; const drain = admission.stop().then(() => { drained = true; });
    await assert.rejects(queued); await assert.rejects(wire(origin, admission, 'new'));
    await delay(20); assert.equal(drained, false); assert.equal(received, 1);
    abort.abort(); await assert.rejects(active); await drain; assert.equal(drained, true);
  } finally { abort.abort(); await stop(peer); await admission.stop(); }
});

test('native callbacks progress independently while every facade control owner awaits them', { timeout: 10_000 }, async () => {
  const owners = new ServiceAdmission();
  const callbacks = new NativeControlAdmission(nativeCallbackCapacity.active, nativeCallbackCapacity.waiting);
  const release = Promise.withResolvers<void>(), allActive = Promise.withResolvers<void>();
  let active = 0, peak = 0, entered = 0, failure: unknown;
  const callback = createServer((req, res) => admitNativeCallback(callbacks, req, res, async () => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-callback-credential');
    active++; peak = Math.max(peak, active); entered++;
    if (entered === nativeCallbackCapacity.active) allActive.resolve();
    try { await release.promise; res.writeHead(200, { connection: 'close' }); res.end('{}'); }
    finally { active--; }
  }));
  callback.maxConnections = nativeCallbackCapacity.sockets;
  const callbackOrigin = await listen(callback);
  const call = async () => {
    const response = await fetch(callbackOrigin, { method: 'POST', headers: { authorization: 'Bearer synthetic-callback-credential' } });
    await response.text(); assert.equal(response.status, 200);
  };
  const facade = createServer((_req, res) => {
    const done = owners.reserve('control');
    if (!done) { res.writeHead(503); res.end(); return; }
    void call().then(() => { res.writeHead(200); res.end('{}'); })
      .catch(error => { failure = error; res.destroy(); }).finally(done);
  });
  const facadeOrigin = await listen(facade);
  try {
    const pending = Array.from({ length: serviceCapacity.controlActive }, async () => {
      const response = await fetch(facadeOrigin); await response.text(); assert.equal(response.status, 200);
    });
    await allActive.promise;
    assert.equal(owners.reserve('control'), undefined, 'all public control owners still await their callbacks');
    const additional = Array.from({ length: serviceCapacity.dataActive }, call);
    await delay(30); assert.equal(entered, nativeCallbackCapacity.active);
    release.resolve(); await Promise.all([...pending, ...additional]);
    assert.equal(entered, serviceCapacity.controlActive + serviceCapacity.dataActive);
    assert.equal(peak, nativeCallbackCapacity.active);
    if (failure) throw failure;
  } finally { release.resolve(); await stop(facade); await stop(callback); await owners.stop(); await callbacks.stop(); }
});

test('callback work throwing after acquisition cannot emit a pre-work refusal', async () => {
  const gate = new NativeControlAdmission(1, 0);
  let work = 0, refused = 0;
  const server = createServer((req, res) => admitNativeCallback(gate, req, res, async () => {
    work++; throw new Error('controlled post-claim failure');
  }, () => { refused++; res.writeHead(503); res.end('must-not-be-issued'); }));
  const origin = await listen(server);
  try {
    const response = await fetch(origin);
    assert.equal(response.status, 503); assert.equal(await response.text(), '');
    assert.equal(work, 1); assert.equal(refused, 0);
  } finally { await stop(server); await gate.stop(); }
});

test('preclaim callback saturation leaves accepted dispatch, closure and settlement progress independent', async () => {
  const preclaim = new NativeControlAdmission(2, 1), critical = new NativeControlAdmission(2, 1), settlement = new NativeControlAdmission(4, 1);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let offers = 0;
  const server = createServer((req, res) => {
    const purpose = nativeCallbackPurpose(req.url), gate = purpose === 'preclaim' ? preclaim : purpose === 'critical' ? critical : settlement;
    admitNativeCallback(gate, req, res, async () => {
      if (purpose === 'preclaim') { if (++offers === 2) entered.resolve(); await release.promise; }
      res.writeHead(200, { connection: 'close' }); res.end('{}');
    });
  });
  const origin = await listen(server);
  const call = async (path: string) => { const response = await fetch(origin + path, { signal: AbortSignal.timeout(2000) }); await response.text(); return response.status; };
  const held = [call('/private/native/v1/execution-authority'), call('/private/native/v1/public-admit')];
  try {
    await entered.promise;
    const queued = call('/private/native/v1/admit'); await delay(20);
    assert.equal(await call('/private/native/v1/execution-authority'), 503);
    for (const path of ['/dispatch-proof', '/owner-closure-authority', '/oauth-custody-authority', '/execution-settle']) {
      assert.equal(await call('/private/native/v1' + path), 200, 'accepted work must progress while every preclaim owner is held');
    }
    assert.equal(offers, 2);
    release.resolve(); assert.deepEqual(await Promise.all([...held, queued]), [200, 200, 200]);
  } finally { release.resolve(); await Promise.allSettled(held); await stop(server); await Promise.all([preclaim.stop(), critical.stop(), settlement.stop()]); }
});
