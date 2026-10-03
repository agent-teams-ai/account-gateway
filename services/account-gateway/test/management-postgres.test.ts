import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresKernel } from '../src/postgres.ts';
import { KernelError } from '../src/domain.ts';
import type { TrustedContext, AccountIntent, OperationStatus } from '../src/domain.ts';
import { AccountManagement } from '../src/management.ts';
import type { CandidateJournal, CandidateScope, CreateInput, NativeReadback } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { NativeManagementClient } from '../src/native-client.ts';

let pool: pg.Pool, lockPool: pg.Pool, kernel: PostgresKernel, custody: IntentSecrets, store: PostgresManagementStore;
const profile = Object.freeze({ profile: 'synthetic-profile',baseURL: 'https://fixture.invalid/v1',model: 'fixture-model',qualificationRef: 'fixture-only' });
function disposable(): { dsn: string; database: string } {
  const dsn = process.env.AG_KERNEL_TEST_DSN, database = process.env.AG_KERNEL_DISPOSABLE_DB;
  if (!dsn || !database || !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
      process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10') throw new Error('NOT_RUN: explicit new disposable PG17.10 fixture required');
  let url: URL; try { url = new URL(dsn); } catch { throw new Error('NOT_RUN: invalid disposable designation'); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + database || url.search || url.hash) throw new Error('NOT_RUN: refusing remote or unspecified DB');
  return { dsn,database };
}
before(async () => {
  const selected = disposable();
  pool = new pg.Pool({ connectionString: selected.dsn,max: 4,connectionTimeoutMillis: 5000 });
  lockPool = new pg.Pool({ connectionString: selected.dsn,max: 1,connectionTimeoutMillis: 5000 });
  pool.on('error',() => undefined); lockPool.on('error',() => undefined);
  try {
    const version = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
    assert.equal(version.db,selected.database); assert.match(version.version,/^17\.10(?:$| )/);
    const present = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')");
    assert.equal(present.rowCount,0,'requires empty disposable DB; never overwrite a schema');
    const directory = new URL('../migrations/',import.meta.url);
    for (const file of (await readdir(directory)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()) {
      await pool.query(await readFile(new URL(file,directory),'utf8'));
    }
    kernel = new PostgresKernel(pool); custody = new IntentSecrets(randomBytes(32),randomBytes(32));
    store = new PostgresManagementStore(pool,custody);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    throw new Error('NOT_RUN: disposable PostgreSQL setup unavailable; vendor details withheld');
  }
});
after(async () => { await Promise.all([pool,lockPool].filter(Boolean).map(p => p.end())); });
const ctx = (): TrustedContext => ({ consumerId: 'synthetic-' + randomUUID() });
const input = (): CreateInput => ({ operationId: randomUUID(),ownerRef: 'workspace-fixture',profile: profile.profile,
  displayName: 'Disposable fixture',apiKey: 'fixture-key-' + randomUUID() });
const isCode = (code: string) => (e: unknown): boolean => e instanceof KernelError && e.code === code;
// Existing private Go candidate and descriptor JSON; fixture performs no provider call.
function nativeBody(d: NativeReadback): object {
  return { descriptor: { account_id: d.nativeId,generation: d.generation,created_at: d.createdAt,
    profile: d.profile,base_url: d.baseURL,model: d.model },name: 'Disposable fixture',state: d.state,
    group_free: true,schedulable: false,probes_enabled: false };
}
let nextNativeID = 734; // One synthetic engine identity space across disposable HTTP listeners.
async function fixture(context: TrustedContext, mode: 'lost_ack' | 'wrong' | 'multiple' | 'zero' | 'error' | 'redirect' | 'activation_lost_ack' = 'lost_ack') {
  let creates = 0, erases = 0, providerCalls = 0;
  const bodies: Record<string,unknown>[] = [], reads: string[] = [], rows = new Map<string,NativeReadback>();
  const server = createServer((req,res) => {
    if (req.url?.startsWith('/provider')) { providerCalls++; res.end('{}'); return; }
    if (req.method === 'POST' && req.url === '/private/native/v1/candidates') {
      creates++; const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer)); req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>; bodies.push(body);
        const generation = String(body.generation);
        rows.set(generation,{ generation,nativePhysicalIdentity: generation,nativeId: nextNativeID++,
          createdAt: '2026-10-03T04:05:06.123456789+00:00',state: 'inactive',...profile });
        req.socket.destroy(); // Native write completed; ACK was lost.
      }); return;
    }
    const generation = req.url?.split('/')[5] ?? '';
    if (req.method === 'GET' && req.url === '/private/native/v1/candidates/' + generation) {
      reads.push(generation);
      if (mode === 'error' || mode === 'redirect') {
        res.statusCode = mode === 'error' ? 401 : 302;
        res.setHeader('location','/provider'); res.end('synthetic-private-body'); return;
      }
      const row = rows.get(generation);
      const candidates = !row || mode === 'zero' ? [] : mode === 'wrong' ? [{ ...row,generation: randomUUID(),nativePhysicalIdentity: randomUUID() }] :
        mode === 'multiple' ? [row,{ ...row,nativeId: 999 }] : [row];
      res.end(JSON.stringify(candidates.length === 1 ? nativeBody(candidates[0]) : candidates.map(nativeBody))); return;
    }
    if (req.method === 'PUT' && req.url === '/private/native/v1/candidates/' + generation) {
      const chunks: Buffer[] = [];
      req.on('data',chunk => chunks.push(chunk as Buffer)); req.on('end',() => {
        const change = JSON.parse(Buffer.concat(chunks).toString()) as { state: 'inactive' | 'active';descriptor: { generation: string;created_at: string;account_id: number } };
        const row = rows.get(generation);
        if (!row || change.descriptor.generation !== row.generation || change.descriptor.created_at !== row.createdAt || change.descriptor.account_id !== row.nativeId) {
          res.statusCode = 409; res.end(); return;
        }
        const updated = { ...row,state: change.state }; rows.set(generation,updated);
        if (mode === 'activation_lost_ack' && change.state === 'active') req.socket.destroy();
        else res.end(JSON.stringify(nativeBody(updated)));
      }); return;
    }
    if (req.method === 'POST' && req.url === '/private/native/v1/candidates/' + generation + '/erase') {
      erases++;
      if (rows.get(generation)?.state !== 'inactive') { res.statusCode = 409; res.end(); return; }
      rows.delete(generation); res.end(JSON.stringify({ state: 'tombstoned',credentials_erased: true })); return;
    }
    providerCalls++; res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  const native = new NativeManagementClient({ origin: 'http://127.0.0.1:' + addr.port,consumerId: context.consumerId,
    controlCredential: 'synthetic-control' });
  const worker = randomUUID(); await kernel.heartbeat(context,worker);
  const manager = new AccountManagement({ kernel,store,custody,native,worker,profiles: [profile,{ ...profile,profile: 'second-fixture-profile' }],
    proof: { async verify(j,d) { return rows.get(j.generation)?.nativeId === d.nativeId; } } });
  return { native,worker,manager,rows,bodies,reads,creates: () => creates,erases: () => erases,providerCalls: () => providerCalls,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function staged(context: TrustedContext, command: CreateInput, targetStore = store): Promise<{ operation: OperationStatus; scope: CandidateScope }> {
  const intent: AccountIntent = { operationId: command.operationId,kind: 'create',ownerRef: command.ownerRef,
    profile: command.profile,displayName: command.displayName,intentDigest: '' };
  intent.intentDigest = custody.digest({ context,intent,apiKey: command.apiKey });
  const operation = await kernel.beginAccount(context,intent); assert.ok(operation.accountRef);
  const scope: CandidateScope = { consumerId: context.consumerId,operationId: command.operationId,accountRef: operation.accountRef,
    ownerRef: command.ownerRef!,purpose: 'create' };
  assert.equal(await targetStore.stage(scope,command.apiKey),true);
  return { operation,scope };
}
async function owned(context: TrustedContext, command: CreateInput, worker: string): Promise<CandidateJournal> {
  const start = await staged(context,command);
  const permit = await kernel.startCandidate(context,command.operationId,worker); assert.ok(permit);
  return store.journal(start.scope,permit.candidate,worker,profile);
}

// Regression: lost native ACK could authorize a second create or promote an unpersisted/lossy physical mapping.
test('B3a actual HTTP lost ACK persists precise mapping before promotion and restart repeats no POST', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const result = await f.manager.create(context,command); assert.equal(result.state,'applied');
    assert.equal(f.creates(),1); assert.equal(f.reads.length,2);
    const journal = await store.readJournal(context,command.operationId); assert.ok(journal);
    assert.deepEqual(f.reads,[journal.generation,journal.generation]);
    const freshStore = new PostgresManagementStore(pool,custody);
    const mapping = await freshStore.mapping(context,journal.generation); assert.ok(mapping);
    assert.equal(mapping.descriptor.nativePhysicalIdentity,journal.generation);
    assert.equal(mapping.descriptor.nativeId,734);
    assert.equal(mapping.descriptor.createdAt,'2026-10-03T04:05:06.123456789+00:00');
    const restarted = new AccountManagement({ kernel: new PostgresKernel(pool),store: freshStore,custody,
      native: f.native,worker: f.worker,profiles: [profile],proof: { async verify() { return true; } } });
    assert.deepEqual(await restarted.create(context,command),result); assert.equal(f.creates(),1);
    assert.equal(await freshStore.credential(journal),undefined);
    assert.deepEqual(Object.keys(await restarted.account(context,result.accountRef!)).sort(),
      ['accountRef','displayName','epoch','ownerRef','profile','revision','state']);
    assert.equal(JSON.stringify(await restarted.operation(context,command.operationId)).includes(command.apiKey),false);
    const requestRows = (await pool.query('SELECT count(*)::integer AS n FROM ag_kernel.requests WHERE consumer=$1',[context.consumerId])).rows[0].n;
    assert.equal(requestRows,0,'management never preclaims an inference request');
  } finally { await f.close(); }
});

// Regression: a crash after sole POST but before readback must recover only its journaled generation, erase intent and avoid recreating.
test('B3a restart after native write uses persisted generation GET and spent permit', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const j = await owned(context,command,f.worker);
    await assert.rejects(f.native.create(j,command.displayName!,command.apiKey));
    const restarted = new AccountManagement({ kernel: new PostgresKernel(pool),store: new PostgresManagementStore(pool,custody),
      custody,native: f.native,worker: f.worker,profiles: [profile],proof: { async verify() { return true; } } });
    assert.equal((await restarted.create(context,command)).state,'applied');
    assert.equal(f.creates(),1); assert.deepEqual(f.reads,[j.generation,j.generation]);
    assert.equal(await store.credential(j),undefined); assert.ok(await store.mapping(context,j.generation));
    assert.equal(await kernel.startCandidate(context,command.operationId,f.worker),undefined);
    await restarted.create(context,command); assert.equal(f.creates(),1);
  } finally { await f.close(); }
});

// Regression: changed key/name/owner/profile intent reuse must conflict, while original ID+intent survives restart and encrypted staging.
test('B3a same and changed intent are governed by kernel HMAC without plaintext JSONB', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const first = await f.manager.create(context,command);
    assert.deepEqual(await f.manager.create(context,{ ...command }),first);
    for (const changed of [{ ...command,apiKey: command.apiKey + 'x' },{ ...command,displayName: 'Changed' },
      { ...command,ownerRef: 'other-owner' },{ ...command,profile: 'second-fixture-profile' }]) await assert.rejects(f.manager.create(context,changed),isCode('conflict'));
    const pendingCommand = input(),pending = await staged(context,pendingCommand);
    const row = (await pool.query('SELECT * FROM ag_management.transient_intents WHERE consumer=$1 AND operation_id=$2',
      [context.consumerId,pendingCommand.operationId])).rows[0];
    assert.ok(Buffer.isBuffer(row.ciphertext)); assert.equal(row.ciphertext.includes(Buffer.from(pendingCommand.apiKey)),false);
    assert.equal(await store.credential(pending.scope) === pendingCommand.apiKey,true);
    const intents = (await pool.query('SELECT intent FROM ag_kernel.operations WHERE consumer=$1',[context.consumerId])).rows;
    assert.equal(JSON.stringify(intents).includes(command.apiKey),false); assert.equal(JSON.stringify(intents).includes(pendingCommand.apiKey),false);
    assert.equal(f.creates(),1);
  } finally { await f.close(); }
});

// Regression: TTL expiry and erase must remove all envelope bytes and must not resurrect credentials or issue a late create.
test('B3a expired encrypted intents erase, remain nonrenewable and bounded at admission saturation', async () => {
  const context = ctx(),command = input();
  const short = new PostgresManagementStore(pool,custody,{ ttlMs: 20,maxIntents: 1,batch: 1 });
  const first = await staged(context,command,short);
  await delay(40); assert.equal(await short.credential(first.scope),undefined);
  await short.expire(context);
  const row = (await pool.query('SELECT nonce,ciphertext,tag FROM ag_management.transient_intents WHERE consumer=$1 AND operation_id=$2',
    [context.consumerId,command.operationId])).rows[0];
  assert.deepEqual(row,{ nonce: null,ciphertext: null,tag: null });
  assert.equal(await short.stage(first.scope,command.apiKey),false);
  const next = input();
  const intent: AccountIntent = { operationId: next.operationId,kind: 'create',intentDigest: 'fixture-intent',ownerRef: next.ownerRef,
    profile: next.profile,displayName: next.displayName };
  const second = await kernel.beginAccount(context,intent); assert.ok(second.accountRef);
  await assert.rejects(short.stage({ ...first.scope,operationId: next.operationId,accountRef: second.accountRef },next.apiKey),isCode('unavailable'));
  // Exact scope mismatch cannot decrypt or erase another consumer's intent.
  assert.equal(await short.credential({ ...first.scope,ownerRef: 'wrong-owner' }),undefined);
});

// Regression: duplicate physical row, altered creation precision, stale model or cross-consumer lookup must never replace immutable mapping.
test('B3a mapping uniqueness, immutable precision/profile and consumer isolation fail closed', async () => {
  const context = ctx(),f = await fixture(context);
  try {
    const one = input(); await f.manager.create(context,one);
    const j = await store.readJournal(context,one.operationId); assert.ok(j);
    const mapping = await store.mapping(context,j.generation); assert.ok(mapping);
    await store.saveMapping(mapping); // Exact persisted acknowledgement is idempotent.
    await assert.rejects(store.saveMapping({ ...mapping,descriptor: { ...mapping.descriptor,createdAt: '2026-10-03T04:05:06.123456Z' } }),isCode('conflict'));
    await assert.rejects(store.saveMapping({ ...mapping,descriptor: { ...mapping.descriptor,model: 'stale-model' } }),isCode('conflict'));
    const second = await owned(context,input(),f.worker);
    await assert.rejects(store.saveMapping({ ...second,descriptor: { ...mapping.descriptor,generation: second.generation,
      nativePhysicalIdentity: second.generation } }),isCode('conflict'));
    const other = ctx(); await kernel.issuer(other);
    assert.equal(await store.mapping(other,j.generation),undefined);
    assert.equal(await store.readJournal(other,one.operationId),undefined);
    const attempt = await pool.query(`UPDATE ag_management.physical_mappings SET native_created_at=native_created_at
      WHERE consumer=$1 AND generation=$2 RETURNING native_created_at`,[context.consumerId,j.generation]);
    assert.equal(attempt.rows[0].native_created_at,'2026-10-03T04:05:06.123456789+00:00');
    await assert.rejects(pool.query('UPDATE ag_management.physical_mappings SET native_id=1 WHERE consumer=$1 AND generation=$2',[context.consumerId,j.generation]),
      (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === '23514');
  } finally { await f.close(); }
});

// Regression: zero/ambiguous/wrong/error/redirect readback must quarantine without a provider call, raw body or second create.
test('B3a wrong native readback, status and redirect quarantine and do not invoke provider', async () => {
  for (const mode of ['wrong','multiple','zero','error','redirect'] as const) {
    const context = ctx(),command = input(),f = await fixture(context,mode);
    try {
      const status = await f.manager.create(context,command); assert.equal(status.state,'unknown');
      assert.equal((await f.manager.account(context,status.accountRef!)).state,'quarantined');
      const j = await store.readJournal(context,command.operationId); assert.ok(j);
      assert.equal(await store.mapping(context,j.generation),undefined);
      assert.equal(await store.credential(j),undefined);
      assert.equal(JSON.stringify(status).includes('synthetic-private-body'),false);
      assert.deepEqual(await f.manager.create(context,command),status);
      assert.equal(f.creates(),1); assert.equal(f.providerCalls(),0);
      assert.equal(await f.manager.cleanup(context),'quarantined'); assert.equal(f.erases(),0);
    } finally { await f.close(); }
  }
});

// Regression: mutation during an awaited real PG lock could switch consumer, owner, intent or submitted credentials before native create.
test('B3a accepted primitives snapshot before awaited consumer transaction', async () => {
  const context = ctx(),originalConsumer = context.consumerId,command = input(),original = { ...command },f = await fixture(context);
  const blocker = await lockPool.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE',[context.consumerId]);
    const running = f.manager.create(context,command);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const waiters = (await blocker.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`)).rows[0].n;
      if (waiters > 0) { blocked = true; break; } await delay(10);
    }
    assert.equal(blocked,true,'must observe real transaction wait before mutation');
    Object.assign(context,{ consumerId: 'changed-consumer' });
    Object.assign(command,{ ownerRef: 'changed-owner',profile: 'changed-profile',displayName: 'Changed',apiKey: 'fixture-changed',operationId: 'changed-op' });
    await blocker.query('COMMIT');
    const status = await running; assert.equal(status.state,'applied');
    assert.equal(f.bodies[0].owner_ref,original.ownerRef); assert.equal(f.bodies[0].profile,original.profile);
    assert.equal(f.bodies[0].api_key === original.apiKey,true);
    assert.equal((await kernel.account({ consumerId: originalConsumer },status.accountRef!)).ownerRef,original.ownerRef);
    assert.equal((await kernel.operation({ consumerId: originalConsumer },original.operationId)).state,'applied');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await f.close(); }
});

// Regression: rename could reconnect credentials or advance auth epoch; reconnect/disable could skip kernel epoch/fence semantics.
test('B3a rename is metadata only; reconnect stages replacement and disable erases only mapped generation', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const result = await f.manager.create(context,command),before = await f.manager.account(context,result.accountRef!);
    await f.manager.rename(context,{ operationId: randomUUID(),accountRef: before.accountRef,expectedRevision: before.revision,displayName: 'Renamed fixture' });
    const renamed = await f.manager.account(context,before.accountRef);
    assert.equal(renamed.epoch,before.epoch); assert.equal(renamed.revision,before.revision + 1); assert.equal(f.creates(),1);
    await f.manager.reconnect(context,{ operationId: randomUUID(),accountRef: renamed.accountRef,expectedRevision: renamed.revision,apiKey: 'fixture-new' + randomUUID() });
    const connected = await f.manager.account(context,before.accountRef);
    assert.equal(connected.epoch,before.epoch + 1); assert.equal(f.creates(),2);
    assert.equal(await f.manager.cleanup(context),'erased'); assert.equal(f.erases(),1);
    await f.manager.disable(context,{ operationId: randomUUID(),accountRef: connected.accountRef,expectedRevision: connected.revision });
    assert.equal((await f.manager.account(context,connected.accountRef)).epoch,connected.epoch + 1);
    assert.equal(await f.manager.cleanup(context),'erased'); assert.equal(f.erases(),2); assert.equal(f.providerCalls(),0);
  } finally { await f.close(); }
});

// Regression: owner loss/restart could promote an expired candidate or guessed cleanup identity; exact readback should only enable fenced cleanup.
test('B3a expired owner recovery records exact physical identity but cannot promote or recreate', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const j = await owned(context,command,f.worker);
    await assert.rejects(f.native.create(j,command.displayName!,command.apiKey));
    await pool.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",[context.consumerId,f.worker]);
    const fresh = randomUUID(); await kernel.heartbeat(context,fresh);
    const recovery = new AccountManagement({ kernel,store,custody,native: f.native,worker: fresh,profiles: [profile],proof: { async verify() { return true; } } });
    const status = await recovery.recover(context,command.operationId);
    assert.equal(status.state,'rejected'); assert.equal((await kernel.account(context,status.accountRef!)).state,'quarantined');
    assert.ok(await store.mapping(context,j.generation)); assert.equal(f.creates(),1);
    assert.equal(await recovery.cleanup(context),'erased'); assert.equal(f.erases(),1);
  } finally { await f.close(); }
});

// Regression: encrypted DB rows alone cannot establish backup safety if pg_dump serializes plaintext or kernel JSONB retains the submitted key.
test('B3a actual private schema dump contains encrypted envelope and no submitted plaintext', async () => {
  const context = ctx(),command = input(); await staged(context,command);
  const selected = disposable();
  const result = await new Promise<{ status: number | null; bytes: Buffer }>((resolve,reject) => {
    // DSN is inherited privately, never command line or diagnostic output.
    const child = spawn('pg_dump',['--dbname',selected.dsn,'--no-owner','--no-privileges','--schema=ag_management','--schema=ag_kernel'],
      { env: { ...process.env,PGDATABASE: selected.dsn },stdio: ['ignore','pipe','ignore'] });
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on('data',(chunk: Buffer) => { size += chunk.length; if (size > 16_777_216) child.kill(); else chunks.push(chunk); });
    child.once('error',() => reject(new Error('NOT_RUN: pg_dump unavailable')));
    child.once('close',status => resolve({ status,bytes: Buffer.concat(chunks) }));
  });
  assert.equal(result.status,0,'actual dump must finish');
  assert.equal(result.bytes.includes(Buffer.from(command.apiKey)),false);
  assert.equal(result.bytes.includes(Buffer.from('transient_intents')),true);
  assert.equal(result.bytes.includes(Buffer.from('physical_mappings')),true);
});

// Regression: a stale native ID, creation text or model readback must never authorize erasure even when the kernel UUID matches.
test('B3a cleanup compares the complete mapped descriptor and refuses stale native row', async () => {
  for (const variant of ['id','createdAt','model'] as const) {
    const context = ctx(),command = input(),f = await fixture(context);
    try {
      const operation = await f.manager.create(context,command);
      const account = await f.manager.account(context,operation.accountRef!);
      const j = await store.readJournal(context,command.operationId); assert.ok(j);
      const d = f.rows.get(j.generation); assert.ok(d);
      f.rows.set(j.generation,{ ...d,...(variant === 'id' ? { nativeId: 999 } : variant === 'createdAt' ?
        { createdAt: '2026-10-03T04:05:06.123456Z' } : { model: 'stale-model' }) });
      await f.manager.disable(context,{ operationId: randomUUID(),accountRef: account.accountRef,expectedRevision: account.revision });
      assert.equal(await f.manager.cleanup(context),'quarantined'); assert.equal(f.erases(),0);
      assert.equal(f.creates(),1); assert.equal(f.providerCalls(),0);
    } finally { await f.close(); }
  }
});

// Regression: encrypted-intent cleanup must not release a held kernel transport or refund its accepted effect/request allowance.
test('B3a generation erasure never frees occupied transport or changes accepted effect', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const created = await f.manager.create(context,command),account = await f.manager.account(context,created.accountRef!);
    const deadline = new Date(Date.now() + 60_000),issuer = await kernel.issuer(context);
    const prepared = await kernel.prepare(context,{ operationId: randomUUID(),intentDigest: 'synthetic-preparation',
      invocationRef: 'synthetic-invocation',attemptRef: 'synthetic-attempt',permittedAccounts: [account.accountRef],
      profile: profile.profile,policySubject: 'fixture-binding',policyRevision: 1,bindingRevision: 1,issuerEpoch: issuer,
      deadline,limits: { requests: 2,concurrency: 1,requestBytes: 4096,outputBytes: 4096,tokens: 32 } });
    assert.ok(prepared.executionRef);
    const claim = await kernel.claim(context,prepared.executionRef,'held-request',f.worker,{ executionRef: prepared.executionRef,
      issuerEpoch: issuer,invocationRef: 'synthetic-invocation',attemptRef: 'synthetic-attempt',accountRef: account.accountRef,
      authorizationEpoch: account.epoch,subjectRef: 'fixture-binding',policyRevision: 1,bindingRevision: 1,profileId: profile.profile,
      limits: { requests: 2,concurrency: 1,requestBytes: 4096,outputBytes: 4096,tokens: 32 },expiresAt: deadline.toISOString() },
      { originRef: 'fixture-origin',engineIncarnation: randomUUID(),requestNonce: randomUUID() });
    assert.ok(claim.dispatch);
    await kernel.effect(context,prepared.executionRef,'held-request',f.worker,'response_started');
    await kernel.effect(context,prepared.executionRef,'held-request',f.worker,'completed');
    await f.manager.disable(context,{ operationId: randomUUID(),accountRef: account.accountRef,expectedRevision: account.revision });
    // Claim both kernel-owned scopes under the same live worker, then dispatch
    // only the generation job to the adapter; transport work belongs to B3.
    const jobs = [await kernel.claimCleanup(context,f.worker),await kernel.claimCleanup(context,f.worker)];
    const generation = jobs.find(j => j?.scope.kind === 'generation'); assert.ok(generation);
    assert.equal(await f.manager.cleanupClaim(context,generation),'erased'); assert.equal(f.erases(),1);
    const execution = jobs.find(j => j?.scope.kind === 'execution'); assert.ok(execution);
    assert.equal(await f.manager.cleanupClaim(context,execution),'transport_pending');
    const held = (await pool.query(`SELECT transport_occupied,effect FROM ag_kernel.requests
      WHERE consumer=$1 AND execution_ref=$2 AND id='held-request'`,[context.consumerId,prepared.executionRef])).rows[0];
    assert.deepEqual(held,{ transport_occupied: true,effect: 'completed' });
    assert.equal((await kernel.request(context,prepared.executionRef,'held-request')).effect,'completed');
    assert.equal((await pool.query('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
      [context.consumerId,prepared.executionRef])).rows[0].n,1);
  } finally { await f.close(); }
});

// Regression: a copied cleanup token after its DB lease expires must not authorize a native credential erase.
test('B3a expired exact cleanup lease refuses native erasure', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const status = await f.manager.create(context,command),account = await f.manager.account(context,status.accountRef!);
    await f.manager.disable(context,{ operationId: randomUUID(),accountRef: account.accountRef,expectedRevision: account.revision });
    const job = await kernel.claimCleanup(context,f.worker); assert.ok(job && job.scope.kind === 'generation');
    await pool.query("UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",[context.consumerId,job.cleanupRef]);
    await assert.rejects(f.manager.cleanupClaim(context,job),isCode('denied'));
    assert.equal(f.erases(),0); assert.equal(f.providerCalls(),0);
  } finally { await f.close(); }
});

// Regression: a lost native activation ACK could trigger a second create or acknowledge a candidate without exact active-state readback.
test('B3a lost state activation ACK uses exact GET after persisted staging proof without another create', async () => {
  const context = ctx(),command = input(),f = await fixture(context,'activation_lost_ack');
  try {
    const result = await f.manager.create(context,command); assert.equal(result.state,'applied');
    const j = await store.readJournal(context,command.operationId); assert.ok(j);
    assert.ok(await store.mapping(context,j.generation));
    assert.equal(f.rows.get(j.generation)?.state,'active'); assert.equal(f.creates(),1);
    assert.deepEqual(f.reads,[j.generation,j.generation]);
    assert.deepEqual(await f.manager.create(context,command),result); assert.equal(f.creates(),1);
    assert.equal(f.providerCalls(),0);
  } finally { await f.close(); }
});

// Regression: an unexplained active native row could bypass inert staging and be promoted without a persisted controlled-proof mapping.
test('B3a unexplained already-active candidate quarantines without activation or promotion', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const j = await owned(context,command,f.worker);
    await assert.rejects(f.native.create(j,command.displayName!,command.apiKey));
    const row = f.rows.get(j.generation); assert.ok(row);
    f.rows.set(j.generation,{ ...row,state: 'active' });
    assert.equal((await f.manager.create(context,command)).state,'unknown');
    assert.equal(await store.mapping(context,j.generation),undefined);
    assert.equal((await kernel.account(context,j.accountRef)).state,'quarantined');
    assert.equal(f.creates(),1); assert.equal(f.providerCalls(),0);
  } finally { await f.close(); }
});

// Regression: expiry of a journaled create intent could leave ciphertext retained or let a repeated operation consume another create permit.
test('B3a reconciliation erases expired owned intent and quarantines its spent create', async () => {
  const context = ctx(),command = input(),f = await fixture(context);
  try {
    const short = new PostgresManagementStore(pool,custody,{ ttlMs: 20 });
    const stagedIntent = await staged(context,command,short);
    const permit = await kernel.startCandidate(context,command.operationId,f.worker); assert.ok(permit);
    const j = await short.journal(stagedIntent.scope,permit.candidate,f.worker,profile);
    const manager = new AccountManagement({ kernel,store: short,custody,native: f.native,worker: f.worker,
      profiles: [profile],proof: { async verify() { return true; } } });
    await delay(40); await manager.reconcile(context);
    assert.equal(await short.credential(j),undefined);
    assert.equal((await kernel.operation(context,command.operationId)).state,'unknown');
    assert.equal((await manager.create(context,command)).state,'unknown');
    assert.equal(f.creates(),0); assert.equal(f.providerCalls(),0);
  } finally { await f.close(); }
});
