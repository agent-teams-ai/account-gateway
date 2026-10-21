import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
const sdk = await import(process.env.GATEWAY_HTTP ?? '../packages/account-gateway/dist/http/index.js');
const gm = await import(process.env.GATEWAY_COMPOSITION ?? '../packages/account-gateway/dist/get-modular/index.js');
const { compileComposition } = await import('@get-modular/core');
const { assemblyFor } = await import('@get-modular/assembly');
const account = { accountRef: 'account-a', ownerRef: 'owner-a', profileId: 'mimo', displayName: 'Test', state: 'active', metadataRevision: 2, authorizationEpoch: 1 };
const bounds = { requests: 5, requestBytes: 4096, outputBytes: 4096, tokens: 1000, concurrency: 1 };
const admission = { invocationRef: 'run-a', attemptRef: 'attempt-a', accountRef: 'account-a', authorizationEpoch: 1, subjectRef: 'policy-a', policyRevision: 1, bindingRevision: 1, profileId: 'mimo', limits: bounds, expiresAt: '2026-10-03T23:00:00Z' };
const safe = (code = 'not_found', effect = 'not_dispatched') => ({ code, traceRef: 'trace-a', effect, retry: { kind: 'readback' } });
async function fixture(t, handler) {
  const server = createServer(async (req, res) => {
    try { await handler(req, res); } catch { res.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { management: sdk.createManagementClient({ origin, role: 'management', token: 'fixture-control', timeoutMs: 1000 }),
    execution: sdk.createExecutionClient({ origin, role: 'execution', token: 'fixture-run', timeoutMs: 1000 }), origin };
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };
const rejects = (promise, code, effect) => assert.rejects(promise, error => error instanceof sdk.GatewayError && error.code === code && error.effect === effect && !JSON.stringify({ message: error.message, ...error }).includes('private-sentinel'));

test('retirement readback binds identity and rejects contradictory closure counts', async t => {
  const complete = { operationRef: 'disable-a', account: { ...account, state: 'disabled', metadataRevision: 3, authorizationEpoch: 2 },
    state: 'completed', fence: { metadataRevision: 3, authorizationEpoch: 2 }, inert: true,
    counts: { retainedGenerations: 2, settledNativeErasureGenerations: 2, retainedExecutions: 2, openExecutions: 0,
      requests: 3, occupiedTransports: 0, acknowledgedNativeTransports: 2, positiveKernelNonEntryRequests: 1, unknownEffects: 1 } };
  let reply = complete, missing = false, calls = 0;
  const { management: m, execution: e, origin } = await fixture(t, (req, res) => {
    calls++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/v1/accounts/account-a/retirement/disable-a');
    json(res, missing ? safe() : reply, missing ? 404 : 200);
  });
  assert.equal('retirement' in e, false);
  assert.deepEqual(await m.retirement('account-a', 'disable-a'), complete);
  const control = sdk.createConsumerControlClient({ origin, role: 'consumer-control', token: 'fixture-control' });
  assert.deepEqual(await control.retirement('account-a', 'disable-a'), complete);
  reply = { ...complete, state: 'pending', inert: false, counts: { retainedGenerations: 1, settledNativeErasureGenerations: 0,
    retainedExecutions: 1, openExecutions: 0, requests: 1, occupiedTransports: 1,
    acknowledgedNativeTransports: 0, positiveKernelNonEntryRequests: 1, unknownEffects: 0 } };
  assert.deepEqual(await m.retirement('account-a', 'disable-a'), reply, 'non-entry does not release occupancy before closure ACK');
  for (const counts of [
    { requests: 1, acknowledgedNativeTransports: 0, positiveKernelNonEntryRequests: 1, unknownEffects: 1 },
    { retainedGenerations: 0, settledNativeErasureGenerations: 0 },
    { settledNativeErasureGenerations: 1 },
  ]) {
    reply = { ...complete, counts: { ...complete.counts, ...counts } };
    await rejects(m.retirement('account-a', 'disable-a'), 'invalid_response', 'effect_unknown');
  }
  for (const counts of [{ occupiedTransports: 2 }, { unknownEffects: 3 }]) {
    reply = { ...complete, state: 'pending', inert: false, counts: { ...complete.counts, ...counts } };
    await rejects(m.retirement('account-a', 'disable-a'), 'invalid_response', 'effect_unknown');
  }
  for (const changed of [{ operationRef: 'other-operation' }, { account: { ...complete.account, accountRef: 'other-account' } },
    { fence: { ...complete.fence, authorizationEpoch: 1 } }, { state: 'pending' }]) {
    reply = { ...complete, ...changed };
    await rejects(m.retirement('account-a', 'disable-a'), 'invalid_response', 'effect_unknown');
  }
  missing = true;
  await rejects(m.retirement('account-a', 'disable-a'), 'safe_error', 'effect_unknown');
  assert.equal(calls, 13, 'each read enters once; missing readback never retries');
});

test('policy-use closure reads only the original fence and preserves ambiguous absence', async t => {
  const completed = { operationRef: 'fence-X',policySubject: 'binding-X',policyRevision: 3,state: 'completed',closed: true,
    counts: { retainedExecutions: 1,openExecutions: 0,requests: 1,occupiedTransports: 0,
      acknowledgedNativeTransports: 1,positiveKernelNonEntryRequests: 0,unknownEffects: 1 } };
  let reply = completed, missing = false;
  const { management: m, execution: e, origin } = await fixture(t,(req,res) => {
    assert.equal(req.method,'GET'); assert.equal(req.url,'/v1/policy-fences/fence-X/closure');
    json(res,missing ? safe() : reply,missing ? 404 : 200);
  });
  assert.equal('policyClosure' in e,false);
  assert.deepEqual(await m.policyClosure('fence-X'),completed);
  assert.deepEqual(await sdk.createConsumerControlClient({ origin,role: 'consumer-control',token: 'fixture-control' }).policyClosure('fence-X'),completed);
  reply={ ...completed,state: 'pending',closed: false,counts: { retainedExecutions: 1,openExecutions: 0,requests: 1,
    occupiedTransports: 1,acknowledgedNativeTransports: 0,positiveKernelNonEntryRequests: 1,unknownEffects: 0 } };
  assert.deepEqual(await m.policyClosure('fence-X'),reply,'non-entry remains occupied until closure ACK');
  reply={ ...completed,operationRef: 'other-fence' }; await rejects(m.policyClosure('fence-X'),'invalid_response','effect_unknown');
  reply={ ...completed,counts: { ...completed.counts,positiveKernelNonEntryRequests: 1,acknowledgedNativeTransports: 0 } };
  await rejects(m.policyClosure('fence-X'),'invalid_response','effect_unknown');
  reply={ ...completed,counts: Object.fromEntries(Object.keys(completed.counts).map(k=>[k,0])) };
  assert.deepEqual(await m.policyClosure('fence-X'),reply);
  missing=true; await rejects(m.policyClosure('fence-X'),'safe_error','effect_unknown');
});

// Regression: an added route, changed CAS, or reserialized native payload breaks the actual HTTP boundary.
test('all thirteen facade routes, exact native bytes and stable readback identities', async t => {
  const observed = [];
  const native = Buffer.from('{ "model":"mimo", "messages":[], "stream":true }\n');
  const { management: m, execution: e } = await fixture(t, async (req, res) => {
    observed.push(`${req.method} ${req.url}`);
    if (req.url.endsWith('/requests') && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer fixture-run');
      assert.deepEqual(await read(req), native);
      assert.equal(req.headers['x-gateway-request-id'], 'request-a');
      assert.deepEqual(JSON.parse(req.headers['x-gateway-admission']), admission);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-gateway-request-ref': 'request-a' }); res.end('data: final\n\n'); return;
    }
    if (req.url.includes('/requests/')) { json(res, { requestRef: 'request-a', effect: 'completed', status: 'completed' }); return; }
    if (req.method === 'GET') {
      if (req.url === '/v1/profiles') json(res, { profiles: [{ profileId: 'mimo', protocol: 'openai-chat', modelIds: ['mimo'], authKinds: ['api_key'] }] });
      else if (req.url.startsWith('/v1/accounts?')) json(res, { accounts: [account] });
      else if (req.url === '/v1/accounts/account-a') json(res, account);
      else json(res, { operationRef: 'op-a', state: 'applied', result: { kind: 'account', accountRef: 'account-a', metadataRevision: 2, authorizationEpoch: 1 } });
      return;
    }
    const body = JSON.parse(await read(req));
    assert.equal(body.operationId, 'op-a');
    if (req.url === '/v1/executions') assert.equal(body.bindingRevision, 7);
    assert.ok(req.url.endsWith('/close') ? req.headers.authorization === 'Bearer fixture-run' : req.headers.authorization === 'Bearer fixture-control');
    if (req.method === 'PATCH' || req.url.endsWith('/reconnect') || req.url.endsWith('/disable')) assert.equal(body.expectedMetadataRevision, 2);
    json(res, { operationRef: body.operationId, state: 'pending' }, 202);
  });
  await m.profiles(); await m.list({ ownerRef: 'owner-a', limit: 10 }); await m.get('account-a');
  await m.connect({ operationId: 'op-a', ownerRef: 'owner-a', profileId: 'mimo', displayName: 'Test', credential: { kind: 'api_key', value: 'fixture-write-only' } });
  await m.rename('account-a', { operationId: 'op-a', expectedMetadataRevision: 2, displayName: 'New' });
  await m.reconnect('account-a', { operationId: 'op-a', expectedMetadataRevision: 2, credential: { kind: 'api_key', value: 'fixture-write-only' } });
  await m.disable('account-a', { operationId: 'op-a', expectedMetadataRevision: 2 }); await m.operation('op-a');
  await m.prepare({ operationId: 'op-a', invocationRef: 'run-a', attemptRef: 'attempt-a', accountRefs: ['account-a'], subjectRef: 'policy-a', policyRevision: 1, bindingRevision: 7, profileId: 'mimo', limits: bounds, deadline: admission.expiresAt });
  const stream = await e.request('execution-a', { requestId: 'request-a', admission, body: native });
  assert.equal(await new Response(stream.body).text(), 'data: final\n\n');
  assert.equal((await e.status('execution-a', 'request-a')).effect, 'completed');
  await e.close('execution-a', { operationId: 'op-a', reason: 'completed' });
  await m.fence({ operationId: 'op-a', subjectRef: 'policy-a', revision: 3 });
  assert.deepEqual(observed, ['GET /v1/profiles', 'GET /v1/accounts?ownerRef=owner-a&limit=10', 'GET /v1/accounts/account-a', 'POST /v1/accounts', 'PATCH /v1/accounts/account-a', 'POST /v1/accounts/account-a/reconnect', 'POST /v1/accounts/account-a/disable', 'GET /v1/operations/op-a', 'POST /v1/executions', 'POST /v1/executions/execution-a/requests', 'GET /v1/executions/execution-a/requests/request-a', 'POST /v1/executions/execution-a/close', 'POST /v1/policy-fences']);
});

// Regression: passthrough schemas, role confusion or unsafe validation exceptions send/retain secrets.
test('strict ingress and separate execution surface reject before network', async t => {
  let calls = 0;
  const { management: m, execution: e, origin } = await fixture(t, () => { calls++; });
  assert.equal('connect' in e, false); assert.equal('prepare' in e, false); assert.equal('fence' in e, false);
  assert.throws(() => sdk.createManagementClient({ origin, role: 'execution', token: 'private-sentinel' }), error => error.code === 'invalid_input');
  for (const extra of [{ consumerId: 'other' }, { nativeId: 9 }, { origin: 'https://other.invalid' }]) {
    assert.throws(() => m.connect({ operationId: 'op-a', ownerRef: 'owner-a', profileId: 'mimo', displayName: 'Test', credential: { kind: 'api_key', value: 'private-sentinel' }, ...extra }), error => !JSON.stringify({ message: error.message, ...error }).includes('private-sentinel'));
  }
  assert.throws(() => m.get('../admin'), error => error.effect === 'not_dispatched');
  const signal = AbortSignal.abort();
  await rejects(e.request('execution-a', { requestId: 'request-a', admission, body: new Uint8Array([1]) }, { signal }), 'cancelled', 'not_dispatched');
  assert.equal(calls, 0);
});

// Regression: an expanded vendor result/error, redirect or oversized JSON must never escape in diagnostics.
test('strict success and error allowlists, bounds and redirect redaction', async t => {
  let mode = 'mutation'; let redirected = 0;
  const { management: m } = await fixture(t, async (req, res) => {
    if (req.url === '/private-sentinel') { redirected++; json(res, account); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: '/private-sentinel' }); res.end('private-sentinel'); return; }
    if (mode === 'oversize') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(' '.repeat(70000)); return; }
    if (mode === 'mutation') { await read(req); json(res, { operationRef: 'op-a', state: 'pending', credential: 'private-sentinel' }, 202); return; }
    if (mode === 'error') json(res, { ...safe(), nativeId: 'private-sentinel' }, 404);
    else if (mode === 'nested') json(res, { operationRef: 'op-a', state: 'applied', result: { kind: 'account', accountRef: 'account-a', metadataRevision: 2, authorizationEpoch: 1, token: 'private-sentinel' } });
    else json(res, { ...account, credential: 'private-sentinel' });
  });
  await rejects(m.disable('account-a', { operationId: 'op-a', expectedMetadataRevision: 2 }), 'invalid_response', 'effect_unknown');
  for (mode of ['redirect', 'oversize', 'error', 'account']) await rejects(m.get('account-a'), 'invalid_response', 'effect_unknown');
  mode = 'nested'; await rejects(m.operation('op-a'), 'invalid_response', 'effect_unknown');
  assert.equal(redirected, 0);
});

// Regression: timeout/404 interpreted as no effect, regenerated identity, or hidden POST retry dispatches twice.
test('lost acknowledgements retain known IDs; readback 404 remains ambiguous; no retry', async t => {
  let mutations = 0; let dispatches = 0;
  const { management: m, execution: e } = await fixture(t, async (req, res) => {
    if (req.method === 'POST') {
      await read(req);
      if (req.url.endsWith('/requests')) dispatches++; else mutations++;
      res.destroy(); return;
    }
    json(res, safe(), 404);
  });
  const mutation = m.disable('account-a', { operationId: 'stable-op', expectedMetadataRevision: 2 });
  await assert.rejects(mutation, error => error.effect === 'effect_unknown' && error.operationRef === 'stable-op');
  assert.equal(sdk.operationPath('stable-op'), '/v1/operations/stable-op');
  await rejects(m.operation('stable-op'), 'safe_error', 'effect_unknown');
  await assert.rejects(e.request('execution-a', { requestId: 'stable-request', admission, body: Buffer.from('{}') }), error => error.effect === 'effect_unknown' && error.requestRef === 'stable-request');
  assert.equal(sdk.requestPath('execution-a', 'stable-request'), '/v1/executions/execution-a/requests/stable-request');
  await rejects(e.status('execution-a', 'stable-request'), 'safe_error', 'effect_unknown');
  assert.equal(mutations, 1); assert.equal(dispatches, 1);
});

// Regression: buffering the entire SSE, ignoring AbortSignal or replaying partial output keeps native work alive.
test('streaming exposes first bytes, propagates cancellation, bounds output, counts dispatch', async t => {
  let dispatches = 0;
  let closed;
  const closeObserved = new Promise(resolve => { closed = resolve; });
  const { execution: e } = await fixture(t, async (req, res) => {
    await read(req); dispatches++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-gateway-request-ref': 'request-a' });
    res.write('data: first\n\n');
    req.socket.once('close', closed);
  });
  const controller = new AbortController();
  const stream = await e.request('execution-a', { requestId: 'request-a', admission, body: Buffer.from('{}') }, { signal: controller.signal });
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.abort();
  await assert.rejects(reader.read(), error => error.effect === 'effect_unknown' && error.code === 'cancelled');
  await Promise.race([closeObserved, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel not observed')), 1000))]);
  assert.equal(dispatches, 1);
});

// Regression: invalid graph or missing factory runs a configuration/resource constructor before validation.
test('public Core/Assembly reject invalid slot and missing factory with zero construction', async () => {
  let constructed = 0;
  const assembly = assemblyFor();
  const host = assembly.bindFactory(gm.managementHost, async () => { constructed++; return { instance: undefined, capabilities: { 'account-gateway/management-config': { origin: 'http://127.0.0.1:1', role: 'management', token: 'fixture' } } }; });
  const client = gm.bindManagementFactory(assembly);
  const invalid = structuredClone(gm.managementProfile); invalid.bindings[0].slotId = 'bad';
  assert.equal((await compileComposition({ declarations: [gm.managementHost, gm.managementDeclaration], profile: invalid })).ok, false);
  const composition = await compileComposition({ declarations: [gm.managementHost, gm.managementDeclaration], profile: gm.managementProfile });
  assert.equal(composition.ok, true);
  assert.equal((await assembly.prepare({ composition, factories: [client], roots: { client } })).status, 'failed');
  assert.equal(constructed, 0);
  const prepared = await assembly.prepare({ composition, factories: [host, client], roots: { client } });
  assert.equal(prepared.status, 'prepared'); assert.equal(constructed, 0);
  assert.equal((await prepared.prepared.run()).status, 'succeeded'); assert.equal(constructed, 1);
});

// Regression: composition factory changes role or origin relative to direct client behavior.
test('static construction matches direct factory against real facade', async t => {
  let calls = 0;
  const { origin, management: direct } = await fixture(t, (req, res) => { calls++; assert.equal(req.headers.authorization, 'Bearer fixture-control'); json(res, account); });
  const composed = await gm.constructManagementClient({ origin, role: 'management', token: 'fixture-control' });
  assert.equal(calls, 0);
  assert.deepEqual(await composed.get('account-a'), await direct.get('account-a'));
  assert.equal(calls, 2);
});

// Regression: output limits ignored or an idempotent status response is treated as a new stream.
test('bounded stream and repeated-request status never add a hidden dispatch', async t => {
  let mode='bounded'; let dispatches=0;
  const { execution: e } = await fixture(t, async (req,res) => {
    await read(req);
    if(mode==='status') { json(res,{requestRef:'request-a',effect:'effect_unknown',status:'unknown'},202); return; }
    dispatches++;
    res.writeHead(200,{'content-type':'text/event-stream','x-gateway-request-ref':'request-a'});res.end('data: exceeds-small-cap\n\n');
  });
  const boundedAdmission={...admission,limits:{...bounds,outputBytes:5}};
  const response=await e.request('execution-a',{requestId:'request-a',admission:boundedAdmission,body:Buffer.from('{}')});
  assert.equal(response.kind,'stream');
  await assert.rejects(new Response(response.body).text(),error=>error.effect==='effect_unknown' && error.code==='invalid_response');
  mode='status';
  const repeated=await e.request('execution-a',{requestId:'request-a',admission,body:Buffer.from('{}')});
  assert.deepEqual(repeated,{kind:'status',status:{requestRef:'request-a',effect:'effect_unknown',status:'unknown'}});
  assert.equal(dispatches,1);
});

// Regression: treating a caller-declared role as authority bypasses facade role denial.
test('facade rejects execution credential on management routes without effects', async t => {
  let effects=0;
  const { origin } = await fixture(t, async (req,res) => {
    await read(req);
    if(req.headers.authorization==='Bearer fixture-run') { json(res,safe('forbidden'),403);return; }
    effects++;json(res,{operationRef:'op-a',state:'pending'},202);
  });
  const wrong=sdk.createManagementClient({origin,role:'management',token:'fixture-run'});
  await rejects(wrong.disable('account-a',{operationId:'op-a',expectedMetadataRevision:2}),'safe_error','not_dispatched');
  assert.equal(effects,0);
});

// Regression: safe readback diagnostics contradict the transport's unknown effect and invite retry.
test('missing readback never exports a not-dispatched diagnostic or timed retry', async t => {
 const { management:m, execution:e }=await fixture(t,(req,res)=>json(res,{...safe(),retry:{kind:'after',milliseconds:1}},404));
 for(const call of [()=>m.operation('stable-op'),()=>e.status('execution-a','stable-request')]) {
  await assert.rejects(call(),error=>error.effect==='effect_unknown' && error.diagnostic.effect==='effect_unknown' && error.diagnostic.retry.kind==='readback');
 }
});
// Regression: facade ingress duplicates or loosens SDK credential validation at its server seam.
test('server-only shared secret submission schemas reject native identity and credential extras', async () => {
 const input={operationId:'op-a',ownerRef:'owner-a',profileId:'mimo',displayName:'Test',credential:{kind:'api_key',value:'fixture'}};
 assert.equal(sdk.secretSubmission.connect.safeParse(input).success,true);
 assert.equal(sdk.secretSubmission.connect.safeParse({...input,nativeId:1}).success,false);
 assert.equal(sdk.secretSubmission.connect.safeParse({...input,credential:{...input.credential,origin:'https://vendor.invalid'}}).success,false);
 const native={requestId:'request-a',admission,body:Buffer.from('{ "model": "mimo" }\n')};
 const parsed=sdk.secretSubmission.nativeRequest.parse(native);
 assert.deepEqual(parsed.body,native.body);
 assert.equal(sdk.secretSubmission.nativeRequest.safeParse({...native,body:{model:'mimo'}}).success,false);
 assert.equal(sdk.secretSubmission.nativeRequest.safeParse({...native,body:new Uint8Array(bounds.requestBytes+1)}).success,false);
 assert.equal(sdk.secretSubmission.nativeRequest.safeParse({...native,consumerId:'other'}).success,false);
 const contracts=await import(process.env.GATEWAY_HTTP ? '@agent-teams/account-gateway/contracts' : '../packages/account-gateway/dist/contracts/index.js');
 assert.equal('secretSubmission' in contracts,false);assert.equal('credential' in contracts,false);
});

// Regression: cancelling after a mutation acknowledgement starts is mislabeled as malformed JSON,
// or retries a credential mutation whose dispatch already reached the facade.
test('cancelling partial mutation readback preserves identity and unknown effect', {timeout:5000}, async t => {
 let mutations=0,headersObserved;
 const received=new Promise(resolve=>{headersObserved=resolve;});
 const responses=channel('undici:request:headers');
 const observe=event=>{
  if(event.request.path==='/v1/accounts/account-a/disable') headersObserved();
 };
 responses.subscribe(observe);t.after(()=>responses.unsubscribe(observe));
 const { management:m }=await fixture(t,async (req,res)=>{
  await read(req);mutations++;
  res.writeHead(202,{'content-type':'application/json'});
  res.write('{"operationRef":"stable-op",');
 });
 const controller=new AbortController();
 const pending=m.disable('account-a',{operationId:'stable-op',expectedMetadataRevision:2},{signal:controller.signal});
 const rejected=assert.rejects(pending,error=>error.code==='cancelled' && error.effect==='effect_unknown' && error.operationRef==='stable-op');
 await received;
 // Drain fetch header-resolution microtasks before aborting its partial body read.
 await new Promise(resolve=>setImmediate(resolve));
 controller.abort();await rejected;
 assert.equal(mutations,1);
});

// Regression: optional list fields become literal "undefined" on the wire.
test('list omits explicit undefined values from its HTTP query', async t => {
 const observed=[];
 const {management:m}=await fixture(t,(req,res)=>{observed.push(req.url);json(res,{accounts:[]});});
 await m.list();
 await m.list({ownerRef:undefined,cursor:undefined,limit:undefined});
 assert.deepEqual(observed,['/v1/accounts','/v1/accounts']);
});

// Regression: nested error identities/effects invite a replay after ambiguous dispatch.
test('request and operation readback reject contradictory nested diagnostics without replay', async t => {
 const observed=[];
 let response;
 const {management:m,execution:e}=await fixture(t,async(req,res)=>{
  observed.push(`${req.method} ${req.url}`);await read(req);
  json(res,response,req.method==='POST'?202:200);
 });
 const ambiguous={requestRef:'stable-request',effect:'effect_unknown',status:'unknown'};
 const requestError={...safe('upstream_failure','effect_unknown'),requestRef:'stable-request'};
 const rejectRequest=promise=>assert.rejects(promise,error=>error.code==='invalid_response' && error.effect==='effect_unknown' && error.requestRef==='stable-request');
 // Isolate identity, effect and timed retry contradictions, rather than relying on one bad field.
 for(const status of [
  {...ambiguous,effect:'not_dispatched'},
  {...ambiguous,status:'completed'},
  {...ambiguous,error:{...requestError,requestRef:'another-request'}},
  {...ambiguous,error:{...requestError,effect:'not_dispatched'}},
  {...ambiguous,error:{...requestError,effect:'not_dispatched',retry:{kind:'after',milliseconds:1}}},
  // Matching effects alone cannot make a timed retry safe for unknown status.
  {...ambiguous,effect:'not_dispatched',error:{...requestError,effect:'not_dispatched',retry:{kind:'after',milliseconds:1}}},
 ]) {
  response=status;
  await rejectRequest(e.status('execution-a','stable-request'));
  await rejectRequest(e.request('execution-a',{requestId:'stable-request',admission,body:Buffer.from('{}')}));
 }
 for(const error of [
  {...safe('upstream_failure','effect_unknown'),operationRef:'another-op'},
  {...safe('upstream_failure'),operationRef:'stable-op'},
  {...safe('upstream_failure'),operationRef:'stable-op',retry:{kind:'after',milliseconds:1}},
 ]) {
  response={operationRef:'stable-op',state:'unknown',error};
  await assert.rejects(m.operation('stable-op'),error=>error.code==='invalid_response' && error.effect==='effect_unknown' && error.operationRef==='stable-op');
 }
 response={...ambiguous,error:requestError};
 assert.deepEqual(await e.status('execution-a','stable-request'),response);
 response={operationRef:'stable-op',state:'unknown',error:{...safe('upstream_failure','effect_unknown'),operationRef:'stable-op'}};
 assert.deepEqual(await m.operation('stable-op'),response);
 // Revoke/expiry/cleanup classification must retain an already accepted effect.
 response={requestRef:'stable-request',effect:'dispatch_started',status:'cancelled',error:{...safe('forbidden','dispatch_started'),requestRef:'stable-request'}};
 assert.deepEqual(await e.status('execution-a','stable-request'),response);
 assert.deepEqual(await e.request('execution-a',{requestId:'stable-request',admission,body:Buffer.from('{}')}),{kind:'status',status:response});
 assert.deepEqual(observed,[
  ...Array.from({length:6},()=>['GET /v1/executions/execution-a/requests/stable-request','POST /v1/executions/execution-a/requests']).flat(),
  ...Array(3).fill('GET /v1/operations/stable-op'),
  'GET /v1/executions/execution-a/requests/stable-request','GET /v1/operations/stable-op',
  'GET /v1/executions/execution-a/requests/stable-request','POST /v1/executions/execution-a/requests',
 ]);
});

// Regression: a multi-account preparation cannot hydrate admission or recover its pinned
// epoch if the SDK drops/rejects the selected identity or consults later account metadata.
test('applied preparation and lost-ack operation GET retain the selected account and epoch', async t => {
  const observed = [];
  const applied = new Map();
  const selected = { kind: 'execution', executionRef: 'execution-selected', accountRef: 'account-b', authorizationEpoch: 17, deadline: admission.expiresAt, state: 'active' };
  const intent = { operationId: 'prepare-applied', invocationRef: 'run-a', attemptRef: 'attempt-a', accountRefs: ['account-a', 'account-b'], subjectRef: 'policy-a', policyRevision: 1, bindingRevision: 7, profileId: 'mimo', limits: bounds, deadline: admission.expiresAt };
  const { management: m, execution: e, origin } = await fixture(t, async (req, res) => {
    observed.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/v1/executions') {
      const body = JSON.parse(await read(req));
      assert.deepEqual(body, { ...intent, operationId: body.operationId });
      assert.deepEqual(body.accountRefs, ['account-a', 'account-b']);
      const result = { operationRef: body.operationId, state: 'applied', result: selected };
      applied.set(body.operationId, result);
      if (body.operationId === 'prepare-lost') res.destroy();
      else json(res, result);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/operations/')) {
      json(res, applied.get(req.url.slice('/v1/operations/'.length))); return;
    }
    assert.equal(req.url, '/v1/executions/execution-selected/requests');
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(req.headers['x-gateway-admission']), {
      ...admission, accountRef: 'account-b', authorizationEpoch: 17, bindingRevision: 7,
    });
    assert.equal((await read(req)).toString(), '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-gateway-request-ref': 'request-selected' });
    res.end('data: final\n\n');
  });
  const acknowledged = await m.prepare(intent);
  assert.deepEqual(acknowledged, { operationRef: 'prepare-applied', state: 'applied', result: selected });
  assert.deepEqual(await m.operation(intent.operationId), acknowledged);
  await assert.rejects(m.prepare({ ...intent, operationId: 'prepare-lost' }), error =>
    error instanceof sdk.GatewayError && error.code === 'transport' && error.effect === 'effect_unknown' && error.operationRef === 'prepare-lost');
  // A fresh client has no preparation cache or first acknowledgement to reconstruct from.
  const fresh = sdk.createManagementClient({ origin, role: 'management', token: 'fixture-control', timeoutMs: 1000 });
  const recovered = await fresh.operation('prepare-lost');
  assert.deepEqual(recovered, { operationRef: 'prepare-lost', state: 'applied', result: selected });
  // Consumer policy composes admission from saved intent and the safe pinned tuple.
  assert.ok(intent.accountRefs.includes(recovered.result.accountRef));
  const pinnedAdmission = {
    invocationRef: intent.invocationRef, attemptRef: intent.attemptRef,
    accountRef: recovered.result.accountRef, authorizationEpoch: recovered.result.authorizationEpoch,
    subjectRef: intent.subjectRef, policyRevision: intent.policyRevision, bindingRevision: intent.bindingRevision,
    profileId: intent.profileId, limits: intent.limits, expiresAt: recovered.result.deadline,
  };
  const response = await e.request(recovered.result.executionRef, { requestId: 'request-selected', admission: pinnedAdmission, body: Buffer.from('{}') });
  assert.equal(await new Response(response.body).text(), 'data: final\n\n');
  assert.deepEqual(observed, [
    'POST /v1/executions', 'GET /v1/operations/prepare-applied',
    'POST /v1/executions', 'GET /v1/operations/prepare-lost',
    'POST /v1/executions/execution-selected/requests',
  ]);
});

// Regression: incomplete/unsafe applied results invite identity inference or replay,
// or export private response data in validation diagnostics after possible effects.
test('malformed selected preparation results fail closed on POST and operation GET without retry', async t => {
  const observed = [];
  let response;
  let status = 200;
  const { management: m } = await fixture(t, async (req, res) => {
    observed.push(`${req.method} ${req.url}`); await read(req); json(res, response, status);
  });
  const selected = { kind: 'execution', executionRef: 'execution-selected', accountRef: 'account-b', authorizationEpoch: 17, deadline: admission.expiresAt, state: 'active' };
  const intent = { operationId: 'stable-prepare', invocationRef: 'run-a', attemptRef: 'attempt-a', accountRefs: ['account-a', 'account-b'], subjectRef: 'policy-a', policyRevision: 1, bindingRevision: 7, profileId: 'mimo', limits: bounds, deadline: admission.expiresAt };
  const invalid = [];
  for (const field of ['accountRef', 'authorizationEpoch']) {
    const omitted = { ...selected }; delete omitted[field]; invalid.push(omitted);
  }
  for (const accountRef of ['', '../private-sentinel', 'a'.repeat(129), 1, null]) invalid.push({ ...selected, accountRef });
  for (const authorizationEpoch of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '17', null]) invalid.push({ ...selected, authorizationEpoch });
  for (const field of ['credential', 'admission', 'nativeDescriptor', 'nativeId', 'prompt', 'output']) invalid.push({ ...selected, [field]: { value: 'private-sentinel' } });
  const rejectMalformed = promise => assert.rejects(promise, error => {
    assert.ok(error instanceof sdk.GatewayError);
    assert.equal(error.code, 'invalid_response');
    assert.equal(error.effect, 'effect_unknown');
    assert.equal(error.operationRef, intent.operationId);
    assert.equal(error.diagnostic, undefined);
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes('private-sentinel'), false);
    return true;
  });
  for (const result of invalid) {
    response = { operationRef: intent.operationId, state: 'applied', result };
    await rejectMalformed(m.prepare(intent));
    await rejectMalformed(m.operation(intent.operationId));
  }
  // Existing discrimination and caller-identity rules also apply to the extended tuple.
  for (const malformed of [
    { operationRef: 'another-operation', state: 'applied', result: selected },
    { operationRef: intent.operationId, state: 'applied', result: { ...selected, kind: 'account' } },
  ]) {
    response = malformed;
    await rejectMalformed(m.prepare(intent));
    await rejectMalformed(m.operation(intent.operationId));
  }
  // A valid account result remains readable, but cannot acknowledge preparation.
  response = { operationRef: intent.operationId, state: 'applied', result: { kind: 'account', accountRef: 'account-b', metadataRevision: 2, authorizationEpoch: 17 } };
  await rejectMalformed(m.prepare(intent));
  assert.deepEqual(await m.operation(intent.operationId), response);
  response = { operationRef: intent.operationId, state: 'applied' };
  await rejectMalformed(m.prepare(intent));
  response.result = selected; status = 202;
  await rejectMalformed(m.prepare(intent));
  await rejectMalformed(m.operation(intent.operationId));
  assert.deepEqual(observed, [
    ...Array.from({ length: invalid.length + 2 }, () => ['POST /v1/executions', 'GET /v1/operations/stable-prepare']).flat(),
    'POST /v1/executions', 'GET /v1/operations/stable-prepare',
    'POST /v1/executions', 'POST /v1/executions', 'GET /v1/operations/stable-prepare',
  ]);
});

// Regression: a proved non-entry must be observable through the public HTTP client,
// without allowing mislabeled success, retry inference or private native proofs.
test('B2a public HTTP readback accepts only consistent positive rejection and never retries', async t => {
  let calls = 0;
  const rejection = { code: 'upstream_failure', traceRef: 'trace-a', effect: 'rejected_before_dispatch', retry: { kind: 'never' } };
  const valid = { requestRef: 'request-a', effect: 'rejected_before_dispatch', status: 'failed', error: { ...rejection, requestRef: 'request-a' } };
  let response = valid;
  const { execution: e, management: m } = await fixture(t, async (req, res) => {
    calls++;
    if (req.method === 'POST') { await read(req); json(res, { ...rejection, requestRef: 'request-a' }, 422); return; }
    json(res, response);
  });
  assert.deepEqual(await e.status('execution-a', 'request-a'), valid);
  response = { operationRef: 'operation-a', state: 'rejected', error: { ...rejection, operationRef: 'operation-a' } };
  assert.deepEqual(await m.operation('operation-a'), response);
  const invalid = [
    ...['completed', 'unknown', 'pending', 'cancelled'].map(status => ({ ...valid, status })),
    { requestRef: 'request-a', effect: 'rejected_before_dispatch', status: 'failed' },
    { ...valid, error: { ...rejection, effect: 'effect_unknown' } },
    { ...valid, error: { ...rejection, retry: { kind: 'readback' } } },
    { ...valid, error: { ...rejection, retry: { kind: 'after', milliseconds: 1 } } },
    { ...valid, effect: 'completed' },
    { ...valid, effect: 'effect_unknown' },
    { ...valid, native: { originRef: 'private-sentinel' } },
    { ...valid, error: { ...rejection, token: 'private-sentinel' } },
  ];
  for (const payload of invalid) {
    response = payload;
    await rejects(e.status('execution-a', 'request-a'), 'invalid_response', 'effect_unknown');
  }
  response = { operationRef: 'operation-a', state: 'unknown', error: { ...rejection, operationRef: 'operation-a' } };
  await rejects(m.operation('operation-a'), 'invalid_response', 'effect_unknown');
  await rejects(e.request('execution-a', { requestId: 'request-a', admission, body: Buffer.from('{}') }), 'safe_error', 'rejected_before_dispatch');
  assert.equal(calls, 2 + invalid.length + 2, 'every public invocation sends exactly one HTTP request');
});

test('consumer usage feed sends only bounded cursor query and rejects scope injection before network', async t => {
  let calls=0;
  const {origin,management,execution}=await fixture(t, (req,res) => {
    calls++; assert.equal(req.url,'/v1/usage?afterCursor=opaque-a&highWaterCursor=opaque-b&limit=2');
    json(res,{observations:[],nextCursor:'opaque-b',highWaterCursor:'opaque-b'});
  });
  const control=sdk.createConsumerControlClient({origin,role:'consumer-control',token:'fixture-control'});
  assert.equal('listUsage' in management,false); assert.equal('listUsage' in execution,false);
  assert.deepEqual(await control.listUsage({afterCursor:'opaque-a',highWaterCursor:'opaque-b',limit:2}),{observations:[],nextCursor:'opaque-b',highWaterCursor:'opaque-b'});
  assert.throws(()=>control.listUsage({consumerId:'foreign',limit:2}),error=>error.code==='invalid_input');
  assert.throws(()=>control.listUsage({limit:101}),error=>error.code==='invalid_input');
  assert.equal(calls,1);
});

test('single usage read is consumer-control only and exposes absence as null without execution effects', async t => {
  let calls=0;
  const {origin,management,execution}=await fixture(t,(req,res)=>{
    calls++;assert.equal(req.method,'GET');assert.equal(req.url,'/v1/usage/execution/request');json(res,{observation:null});
  });
  const control=sdk.createConsumerControlClient({origin,role:'consumer-control',token:'fixture-control'});
  assert.equal('observeUsage' in management,false);assert.equal('observeUsage' in execution,false);
  assert.equal(await control.observeUsage('execution','request'),null);assert.equal(calls,1);
});
