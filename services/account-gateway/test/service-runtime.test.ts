// ONE actual service lifecycle: production Go CLI + Node entry + externally
// migrated NEW disposable PG17.10 + controlled TLS Responses. No paid provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as c from '@agent-teams/account-gateway/contracts';
import { createManagementClient, createExecutionClient } from '@agent-teams/account-gateway/http';
import { startService } from '../src/service.ts';
import type { Service } from '../src/service.ts';
import { strictJSON } from '../src/facade-ingress.ts';
import { object } from '../src/native-wire.ts';

// Fixture-owned input projection. Actual startService validates production
// configuration; this test independently checks the disposable designation.
interface FixtureConfig {
  kernelDSN: string; facadeOrigin: string; callbackOrigin: string;
  native: { bootstrapFile: string; authorityDir: string; uid: number; gid: number;
    executable: string; origin: string };
  consumer: { consumerId: string };
  profile: { profile: string; model: string; qualificationRef: string;
    baseURL: string; limits: c.Prepare['limits']; providerTokenUpperBound: number };
  bearers: { role: 'management' | 'run-control'; ownerRefs: string[]; token: string }[];
}

const installation = '/opt/account-gateway-service-entry';
const fail = (phase: string): never => { throw new Error('service fixture: ' + phase); };
const ensure = (value: unknown, phase: string): void => { if (!value) fail(phase); };
function protectedFile(path: string): Buffer {
  for (let a = dirname(path);; a = dirname(a)) {
    const s = lstatSync(a); ensure(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022), 'protected ancestor');
    if (a === '/') break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); ensure(s.uid === 0 && s.isFile() && s.nlink === 1 && (s.mode & 0o777) === 0o600 && s.size <= 65_536, 'protected input');
    const b = Buffer.alloc(65_537); let size = 0, n: number;
    do { n = readSync(fd, b, size, b.length - size, size); size += n; } while (n && size < b.length);
    ensure(size <= 65_536, 'input bound'); return b.subarray(0, size);
  } finally { closeSync(fd); }
}
function disposable(dsn: string, kind: 'kernel' | 'native'): string {
  let u: URL; try { u = new URL(dsn); } catch { return fail('invalid disposable designation'); }
  ensure(['postgres:', 'postgresql:'].includes(u.protocol) && u.host === '127.0.0.1:5432' && u.username === 'postgres' &&
    !u.password && !u.hash && u.search === '?sslmode=disable' &&
    new RegExp('^/ag_service_entry_' + kind + '_[a-f0-9]{32}$').test(u.pathname), 'explicit disposable database');
  return u.pathname.slice(1);
}

test('production service entry: awaited startup abort rollback, safe create, SAME OPEN concurrency1, authenticated closure, exact parent retirement',
  { timeout: 75_000 }, async () => {
    if (process.env.AG_SERVICE_ENTRY_ALLOW !== 'new_disposable_root_pg17_10' || process.geteuid?.() !== 0)
      fail('NOT_RUN explicit root disposable fixture required');
    // Manifest contains root/server-only fixture configuration. No keys/DSNs
    // or native bootstrap JSON are accepted through environment variables.
    const manifest = object(strictJSON(protectedFile(installation + '/fixture.json')),
      ['serviceConfig','nativeDSN','gatewaySourceRef','nativeSourceRef','normHash']);
    ensure(manifest.gatewaySourceRef === 'c7549d1e5ab816858c40064276565e3c5ca181d6' &&
      manifest.nativeSourceRef === '65ece8b7626cc5a492c8080d475f6b94ae5938fb' &&
      manifest.normHash === '66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0', 'fixture source pins');
    ensure(typeof manifest.serviceConfig === 'string' && /^\/root\/account_gateway_service_entry_[a-f0-9]{32}\/service.json$/.test(manifest.serviceConfig), 'fixture root');
    ensure(typeof manifest.nativeDSN === 'string', 'native database designation');
    const configFile = manifest.serviceConfig as string, cfg = strictJSON(protectedFile(configFile)) as FixtureConfig, nativeDSN = manifest.nativeDSN as string;
    ensure(cfg.native.bootstrapFile === dirname(configFile) + '/bootstrap.json' && cfg.native.authorityDir === dirname(configFile) + '/authority' &&
      cfg.native.uid === 65534 && cfg.native.gid === 65534 && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'protected disposable launch');
    const kernelDB = disposable(cfg.kernelDSN, 'kernel'), nativeDB = disposable(nativeDSN, 'native');
    ensure(kernelDB.slice(-32) === nativeDB.slice(-32), 'paired disposable databases');
    ensure(cfg.native.executable === installation + '/account-gateway' && cfg.profile.model === 'mimo-test' &&
      cfg.profile.qualificationRef === 'controlled-service-entry-v1' && cfg.profile.limits.requests === 2 &&
      cfg.profile.limits.concurrency === 1 && cfg.profile.limits.requestBytes === 4096 && cfg.profile.limits.outputBytes === 65_536 &&
      cfg.profile.limits.tokens === 32 && cfg.profile.providerTokenUpperBound === 100, 'controlled qualified profile');
    const base = new URL(cfg.profile.baseURL);
    ensure(base.protocol === 'https:' && base.hostname === '127.0.0.1' && base.port && base.pathname === '/v1', 'controlled TLS origin');
    const management = cfg.bearers.find(b => b.role === 'management'), control = cfg.bearers.find(b => b.role === 'run-control');
    ensure(management && control && management.ownerRefs[0] === control.ownerRefs[0], 'configured backend roles');
    const ownerRef = management!.ownerRefs[0], dummy = 'dummy-service-entry-only-' + randomUUID();
    const kernelPool = new pg.Pool({ connectionString: cfg.kernelDSN, max: 2, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    const nativePool = new pg.Pool({ connectionString: nativeDSN, max: 2, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    kernelPool.on('error', () => undefined); nativePool.on('error', () => undefined);
    let service: Service | undefined, calls = 0, violation = false, phase = 'fixture';
    const upstream = createServer({ cert: protectedFile(installation + '/tls/server.pem'), key: protectedFile(installation + '/tls/server-key.pem'),
      maxHeaderSize: 16_384, headersTimeout: 5000, requestTimeout: 5000 }, (req, res) => {
      void (async () => {
        const entry = ++calls; let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { const b = Buffer.from(chunk as Uint8Array); size += b.length; ensure(size <= 4096, 'upstream body bound'); chunks.push(b); }
        const body = object(strictJSON(Buffer.concat(chunks)), ['model','input','stream','store','service_tier','max_output_tokens']);
        ensure(entry <= 2 && req.method === 'POST' && req.url === '/v1/responses' && req.headers.authorization === 'Bearer ' + dummy &&
          body.model === cfg.profile.model && body.stream === true && body.store === false && body.service_tier === 'default' &&
          body.max_output_tokens === 32 && Array.isArray(body.input) && body.input.length === 1, 'qualified native Responses');
        const input = object((body.input as unknown[])[0], ['role','content']);
        ensure(input.role === 'user' && input.content === 'service question ' + entry, 'request identity');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const text = 'service completion ' + entry, itemId = 'msg_service_' + entry;
        const part = { type: 'output_text', text, annotations: [], logprobs: [] };
        const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
        const response = { id: 'resp_service_' + entry, object: 'response', created_at: 1700000000, status: 'completed', model: cfg.profile.model,
          store: false, service_tier: 'default', error: null, incomplete_details: null, output: [item], usage: {
            input_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 5 } };
        let sequence = 0;
        const frame = (type: string, fields: Record<string, unknown>) => res.write('event: ' + type + '\ndata: ' +
          JSON.stringify({ type, sequence_number: sequence++, ...fields }) + '\n\n');
        const pending = { ...response, status: 'in_progress', output: [], usage: null };
        frame('response.created', { response: pending }); frame('response.in_progress', { response: pending });
        frame('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        frame('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text: '' } });
        frame('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text, logprobs: [] });
        frame('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] });
        frame('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part });
        frame('response.output_item.done', { output_index: 0, item }); frame('response.completed', { response }); res.end();
      })().catch(() => { violation = true; res.destroy(); });
    });
    try {
      for (const [pool, database] of [[kernelPool, kernelDB], [nativePool, nativeDB]] as const) {
        const r = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
        ensure(r.db === database && /^17\.10(?:$| )/.test(r.version as string), 'PG17.10 identity');
      }
      // Operator already applied native and kernel migrations; empty new rows
      // are required, but no migration/build/install runs inside this test.
      ensure((await kernelPool.query('SELECT 1 FROM ag_kernel.consumers UNION ALL SELECT 1 FROM ag_kernel.accounts UNION ALL SELECT 1 FROM ag_kernel.executions UNION ALL SELECT 1 FROM ag_kernel.operations UNION ALL SELECT 1 FROM ag_management.physical_mappings LIMIT 1')).rowCount === 0, 'new kernel fixture');
      ensure((await nativePool.query('SELECT 1 FROM public.accounts LIMIT 1')).rowCount === 0, 'new native fixture');
      phase = 'startup-rollback';
      const children = '/proc/self/task/' + process.pid + '/children';
      ensure(readdirSync(cfg.native.authorityDir).length === 0 && readFileSync(children, 'utf8').trim() === '', 'unused protected launcher');
      const abort = new AbortController(), lock = await kernelPool.connect();
      let startup: Promise<boolean> | undefined;
      try {
        await lock.query('BEGIN');
        await lock.query("SET LOCAL lock_timeout = '1000ms'");
        // Block the LAST schema probe: earlier probes are followed by SQL that
        // pool.end() rejects, so they cannot expose the historical listener leak.
        await lock.query('LOCK TABLE ag_kernel.requests IN ACCESS EXCLUSIVE MODE');
        const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        startup = startService(configFile, abort.signal).then(s => { service = s; return false; },
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 'startup_denied');
        const probe = 'SELECT transport_occupied,closure_token,native_origin_ref,engine_incarnation,request_nonce,descriptor_generation FROM ag_kernel.requests LIMIT 0';
        const deadline = Date.now() + 2000; let blocked = false;
        do {
          blocked = (await kernelPool.query<{ blocked: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND query=$1 AND wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid))) AS blocked`, [probe, blocker])).rows[0].blocked;
          if (!blocked) await delay(10);
        } while (!blocked && Date.now() < deadline);
        ensure(blocked, 'observed startup relation-lock wait');
        abort.abort(); // Shutdown snapshots the still-unbound callback here.
      } finally {
        abort.abort();
        try { await lock.query('ROLLBACK'); } finally { lock.release(); }
        if (startup) assert.equal(await Promise.race([startup,
          delay(15_000, undefined, { ref: false }).then(() => fail('startup rollback bound'))]), true, 'aborted awaited startup rejects');
      }
      ensure(readFileSync(children, 'utf8').trim() === '' && readdirSync(cfg.native.authorityDir).length === 0, 'no protected child or launcher evidence');
      // Rebinding proves ports are free even when failed startup cleared admission.
      for (const origin of [cfg.callbackOrigin, cfg.facadeOrigin, cfg.native.origin]) {
        const listener = createServer();
        try {
          await Promise.race([new Promise<void>((resolve, reject) => {
            listener.once('error', () => reject(new Error('service fixture: rollback port available'))); listener.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
          }), delay(1000, undefined, { ref: false }).then(() => fail('rollback port bind bound'))]);
        } finally {
          await Promise.race([new Promise<void>(resolve => listener.close(() => resolve())),
            delay(1000, undefined, { ref: false }).then(() => fail('rollback port close bound'))]);
        }
      }
      assert.equal(calls, 0, 'cancelled startup must not enter upstream');
      await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(Number(base.port), '127.0.0.1', resolve); });
      phase = 'startup';
      service = await startService(configFile);
      const initial = service.binding;
      ensure(typeof initial.pid === 'string' && typeof initial.birthTicks === 'string', 'decimal production binding');
      const client = createManagementClient({ role: 'management', origin: cfg.facadeOrigin, token: management!.token, timeoutMs: 5000 });
      phase = 'catalog';
      const catalog = await client.profiles();
      ensure(catalog.profiles.length === 1 && catalog.profiles[0].profileId === cfg.profile.profile && catalog.profiles[0].modelIds[0] === cfg.profile.model, 'fixed safe catalog');
      phase = 'connect';
      const created = await client.connect({ operationId: randomUUID(), ownerRef, profileId: cfg.profile.profile,
        displayName: 'Disposable service fixture', credential: { kind: 'api_key', value: dummy } });
      ensure(created.state === 'applied' && created.result?.kind === 'account', 'authenticated physical account staging');
      if (created.state !== 'applied' || created.result?.kind !== 'account') return fail('account result');
      const accountRef = created.result.accountRef;
      assert.equal(calls, 0, 'staging must not dispatch a paid probe');
      const prepare: c.Prepare = { operationId: randomUUID(), invocationRef: randomUUID(), attemptRef: 'service-fixture-attempt',
        accountRefs: [accountRef], subjectRef: 'service-fixture-binding', policyRevision: 1, bindingRevision: 1,
        profileId: cfg.profile.profile, limits: { ...cfg.profile.limits }, deadline: new Date(Date.now() + 45_000).toISOString() };
      phase = 'run-access';
      const accessResponse = await fetch(cfg.facadeOrigin + '/internal/v1/run-access', { method: 'POST',
        headers: { authorization: 'Bearer ' + control!.token, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(prepare), signal: AbortSignal.timeout(5000) });
      assert.equal(accessResponse.status, 200);
      const access = object(await accessResponse.json(), ['operation','bearer','admission']);
      const op = c.preparationOperation.parse(access.operation), admission = c.admission.parse(access.admission);
      ensure(op.state === 'applied' && op.result?.kind === 'execution' && typeof access.bearer === 'string', 'persisted run-control preparation');
      if (op.state !== 'applied' || op.result?.kind !== 'execution') return fail('execution result');
      const executionRef = op.result.executionRef;
      const execution = createExecutionClient({ role: 'execution', origin: cfg.facadeOrigin, token: access.bearer as string, timeoutMs: 5000 });
      const wrongRole = await fetch(cfg.facadeOrigin + '/v1/accounts', { headers: { authorization: 'Bearer ' + access.bearer,
        accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
      assert.equal(wrongRole.status, 403); await wrongRole.body?.cancel();
      for (let i = 1; i <= 2; i++) {
        phase = 'stream';
      const requestId = randomUUID(), result = await execution.request(executionRef, { requestId, admission,
          body: Buffer.from(JSON.stringify({ model: cfg.profile.model, input: [{ role: 'user', content: 'service question ' + i }],
            stream: true, store: false, service_tier: 'default' })) });
        ensure(result.kind === 'stream', 'actual stream'); if (result.kind !== 'stream') return fail('stream');
        const reader = result.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; ensure(size <= 65_536, 'output bound'); chunks.push(next.value); }
        ensure(Buffer.concat(chunks).includes(Buffer.from('response.completed')), 'actual completed Responses');
        phase = 'closure';
      assert.equal((await execution.status(executionRef, requestId)).effect, 'completed');
        let released = false;
        for (let n = 0; n < 100 && !released; n++) {
          const row = (await kernelPool.query('SELECT effect,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
            [cfg.consumer.consumerId, executionRef, requestId])).rows[0];
          released = row?.effect === 'completed' && row.transport_occupied === false;
          if (!released) await delay(25);
        }
        ensure(released, 'authenticated physical closure releases occupancy');
        const row = (await kernelPool.query('SELECT state,request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2', [cfg.consumer.consumerId, executionRef])).rows[0];
        ensure(row.state === 'open' && row.request_count === i, 'SAME OPEN concurrency1 execution');
      }
      assert.equal(calls, 2); ensure(!violation, 'controlled upstream assertions');
      const rows = (await kernelPool.query('SELECT native_origin_ref,engine_incarnation,request_nonce,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2', [cfg.consumer.consumerId, executionRef])).rows;
      ensure(rows.length === 2 && rows.every(r => r.native_origin_ref === initial.originRef && r.engine_incarnation === initial.incarnation && !r.transport_occupied) &&
        new Set(rows.map(r => r.request_nonce)).size === 2, 'original enrolled native proof for both claims');
      phase = 'retirement';
      assert.equal(await service.stop(), 'retired', 'original Go parent must emit exact same-binding retirement and exit zero');
      assert.equal(await service.stopped, 'retired');
      await assert.rejects(fetch(cfg.facadeOrigin + '/v1/profiles', { signal: AbortSignal.timeout(1000) }), () => true);
      service = undefined;
    } catch (error) {
      if (error instanceof Error && error.message === 'service fixture: rollback port available') throw error;
      fail('lifecycle failed: ' + phase);
    }
    finally {
      await service?.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await Promise.all([kernelPool.end(), nativePool.end()]);
    }
  });
