import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { PostgresKernel } from '../src/postgres.ts';
import { KernelError, defaults, factDefaults } from '../src/domain.ts';
import type { TrustedContext, AccountIntent, ApprovedPreparation, OperationStatus, PrivateAdmission, CleanupClaim, TransportClosure, NativeReservation, NativeDispatchProof } from '../src/domain.ts';

// Only a new, explicitly designated disposable localhost PostgreSQL 17.10 DB.
// Never print the DSN or a vendor error; no fallback DB or production fixtures.
const dsn = process.env.AG_KERNEL_TEST_DSN;
const database = process.env.AG_KERNEL_DISPOSABLE_DB;
function safeTestDsn(): string {
  if (!dsn || !database || !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
      process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10') throw new Error('NOT_RUN: explicit disposable DB required');
  let url: URL;
  try { url = new URL(dsn); } catch { throw new Error('invalid disposable DB designation'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + database || url.search || url.hash) throw new Error('refusing unspecified or remote DB');
  return dsn;
}
let admin: pg.Pool, poolA: pg.Pool, poolB: pg.Pool;
let a: PostgresKernel, b: PostgresKernel, pids: number[];
let migrated = false;
const legacy = { ctx: { consumerId: 'legacy-' + randomUUID() }, account: randomUUID(),
  execution: randomUUID(), generation: randomUUID(), worker: randomUUID() };
// Actual pre-002 rows: active, unknown and terminal effects never proved closure.
async function seedLegacyRequests(): Promise<void> {
  const consumer = legacy.ctx.consumerId;
  await admin.query('INSERT INTO ag_kernel.consumers(consumer) VALUES ($1)', [consumer]);
  await admin.query(`INSERT INTO ag_kernel.workers(consumer,worker,lease_until)
    VALUES ($1,$2,clock_timestamp()-interval '1 second')`, [consumer, legacy.worker]);
  await admin.query(`INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state)
    VALUES ($1,$2,'workspace-fixture','mimo-test','Legacy disposable','staging')`, [consumer, legacy.account]);
  await admin.query(`INSERT INTO ag_kernel.operations(consumer,id,intent,state,account_ref)
    VALUES ($1,'legacy-create','{}','applied',$2)`, [consumer, legacy.account]);
  await admin.query(`INSERT INTO ag_kernel.candidates(consumer,generation,account_ref,operation_id,profile,
    expected_revision,expected_epoch,state,native_identity) VALUES ($1,$2,$3,'legacy-create','mimo-test',1,1,'ready',$4)`,
  [consumer, legacy.generation, legacy.account, randomUUID()]);
  await admin.query(`UPDATE ag_kernel.accounts SET state='active',active_generation=$3 WHERE consumer=$1 AND ref=$2`,
    [consumer, legacy.account, legacy.generation]);
  await admin.query(`INSERT INTO ag_kernel.policy_fences(consumer,subject,revision) VALUES ($1,'binding-fixture',1)`, [consumer]);
  await admin.query(`INSERT INTO ag_kernel.executions(consumer,ref,invocation,attempt_ref,intent,account_ref,account_epoch,
    profile,generation,policy_subject,policy_revision,binding_revision,issuer,policy_fence,deadline,
    max_requests,max_concurrent,max_request_bytes,max_output_bytes,max_tokens,request_count,state)
    SELECT $1,$2,'legacy-invocation','attempt-a','{}',$3,1,'mimo-test',$4,'binding-fixture',1,0,c.issuer,f.fence,
      clock_timestamp()+interval '1 day',6,1,4096,8192,5000,4,'closed'
    FROM ag_kernel.consumers c JOIN ag_kernel.policy_fences f ON f.consumer=c.consumer WHERE c.consumer=$1`,
  [consumer, legacy.execution, legacy.account, legacy.generation]);
  await admin.query(`INSERT INTO ag_kernel.requests(consumer,execution_ref,id,effect,worker)
    VALUES ($1,$2,'legacy-completed','completed',$3),($1,$2,'legacy-unknown','effect_unknown',$3),
      ($1,$2,'legacy-denied','not_dispatched',NULL),($1,$2,'legacy-dispatch','dispatch_started',$3),
      ($1,$2,'legacy-response','response_started',$3)`, [consumer, legacy.execution, legacy.worker]);
}
const recoveryHistory = { ctx: { consumerId: 'recovery-history-' + randomUUID() },
  account: randomUUID(), execution: randomUUID(), generation: randomUUID(),
  workers: Array.from({ length: 16 }, () => randomUUID()),
  issuers: Array.from({ length: 32 }, () => randomUUID()), token: randomUUID(),
  incarnation: randomUUID(), nonce: randomUUID() };
// Accepted SQL003/004 state before bounded retention, with no live worker.
async function seedRecoveryHistory(): Promise<void> {
  const h = recoveryHistory, consumer = h.ctx.consumerId;
  await admin.query('INSERT INTO ag_kernel.consumers(consumer,issuer) VALUES ($1,$2)', [consumer, h.issuers[0]]);
  await admin.query(`INSERT INTO ag_kernel.workers(consumer,worker,lease_until)
    SELECT $1,id,clock_timestamp()-interval '1 second' FROM unnest($2::uuid[]) AS id`, [consumer, h.workers]);
  await admin.query(`INSERT INTO ag_kernel.issuer_epochs(consumer,issuer)
    SELECT $1,id FROM unnest($2::uuid[]) AS id`, [consumer, h.issuers]);
  await admin.query(`INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state)
    VALUES ($1,$2,'workspace-fixture','mimo-test','Disposable recovery history','staging')`, [consumer, h.account]);
  await admin.query(`INSERT INTO ag_kernel.operations(consumer,id,intent,state,account_ref)
    VALUES ($1,'history-create','{}','applied',$2)`, [consumer, h.account]);
  await admin.query(`INSERT INTO ag_kernel.candidates(consumer,generation,account_ref,operation_id,profile,
    expected_revision,expected_epoch,state,native_identity,worker)
    VALUES ($1,$2,$3,'history-create','mimo-test',1,1,'ready',$2,$4)`,
  [consumer, h.generation, h.account, h.workers[0]]);
  await admin.query(`UPDATE ag_kernel.accounts SET state='active',active_generation=$3
    WHERE consumer=$1 AND ref=$2`, [consumer, h.account, h.generation]);
  await admin.query(`INSERT INTO ag_kernel.policy_fences(consumer,subject,revision)
    VALUES ($1,'binding-fixture',1)`, [consumer]);
  await admin.query(`INSERT INTO ag_kernel.executions(consumer,ref,invocation,attempt_ref,intent,account_ref,account_epoch,
    profile,generation,policy_subject,policy_revision,binding_revision,issuer,policy_fence,deadline,
    max_requests,max_concurrent,max_request_bytes,max_output_bytes,max_tokens,request_count,state)
    SELECT $1,$2,'history-invocation','attempt-a','{}',$3,1,'mimo-test',$4,'binding-fixture',1,0,c.issuer,f.fence,
      clock_timestamp()+interval '1 hour',4,1,4096,8192,5000,1,'closed'
    FROM ag_kernel.consumers c JOIN ag_kernel.policy_fences f ON f.consumer=c.consumer WHERE c.consumer=$1`,
  [consumer, h.execution, h.account, h.generation]);
  await admin.query(`INSERT INTO ag_kernel.requests(consumer,execution_ref,id,effect,worker,closure_token,
    native_origin_ref,engine_incarnation,request_nonce,descriptor_generation)
    VALUES ($1,$2,'history-unknown','effect_unknown',$3,$4,'sandbox-native-origin',$5,$6,$7)`,
  [consumer, h.execution, h.workers[0], h.token, h.incarnation, h.nonce, h.generation]);
  await admin.query(`INSERT INTO ag_kernel.cleanup(consumer,execution_ref,state,worker,token,lease_until)
    VALUES ($1,$2,'claimed',$3,$4,clock_timestamp()-interval '1 second')`,
  [consumer, h.execution, h.workers[0], randomUUID()]);
}
before(async () => {
  const connectionString = safeTestDsn();
  admin = new pg.Pool({ connectionString, max: 2 });
  // Keep the two observed backend identities alive across the deadline barrier.
  poolA = new pg.Pool({ connectionString, max: 1, idleTimeoutMillis: 0 });
  poolB = new pg.Pool({ connectionString, max: 1, idleTimeoutMillis: 0 });
  try {
    const v = await admin.query("SELECT current_database() AS db,current_setting('server_version') AS version");
    assert.equal(v.rows[0].db, database);
    assert.match(v.rows[0].version, /^17\.10(?:$| )/);
    const exists = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='ag_kernel'");
    assert.equal(exists.rowCount, 0, 'requires NEW disposable database; never overwrite an existing schema');
    const directory = new URL('../migrations/', import.meta.url);
    const migrations = (await readdir(directory)).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
    for (const name of migrations) {
      await admin.query(await readFile(new URL(name, directory), 'utf8'));
      if (name.startsWith('001_')) await seedLegacyRequests();
      // A real accepted SQL002 row may have a closure token but no native
      // authority. Seed before003, without inventing its future native tuple.
      if (name.startsWith('002_')) {
        // Seed the accepted SQL002 state directly: the new kernel requires005.
        // This still exercises upgrade of a populated DB with a real NULL binding.
        nativeLegacy.account = randomUUID(); nativeLegacy.worker = randomUUID();
        nativeLegacy.execution = randomUUID(); nativeLegacy.generation = randomUUID();
        const c = nativeLegacy.ctx.consumerId;
        await admin.query('INSERT INTO ag_kernel.consumers(consumer) VALUES ($1)', [c]);
        await admin.query(`INSERT INTO ag_kernel.workers(consumer,worker,lease_until)
          VALUES ($1,$2,clock_timestamp()+interval '30 seconds')`, [c, nativeLegacy.worker]);
        await admin.query(`INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state)
          VALUES ($1,$2,'workspace-fixture','mimo-test','Disposable SQL002','staging')`, [c, nativeLegacy.account]);
        await admin.query(`INSERT INTO ag_kernel.operations(consumer,id,intent,state,account_ref)
          VALUES ($1,'pre003-create','{}','applied',$2)`, [c, nativeLegacy.account]);
        await admin.query(`INSERT INTO ag_kernel.candidates(consumer,generation,account_ref,operation_id,profile,
          expected_revision,expected_epoch,state,native_identity,worker)
          VALUES ($1,$2,$3,'pre003-create','mimo-test',1,1,'ready',$4,$5)`,
        [c, nativeLegacy.generation, nativeLegacy.account, randomUUID(), nativeLegacy.worker]);
        await admin.query(`UPDATE ag_kernel.accounts SET state='active',revision=2,active_generation=$3
          WHERE consumer=$1 AND ref=$2`, [c, nativeLegacy.account, nativeLegacy.generation]);
        await admin.query(`INSERT INTO ag_kernel.policy_fences(consumer,subject,revision)
          VALUES ($1,'binding-fixture',1)`, [c]);
        await admin.query(`INSERT INTO ag_kernel.executions(consumer,ref,invocation,attempt_ref,intent,account_ref,account_epoch,
          profile,generation,policy_subject,policy_revision,binding_revision,issuer,policy_fence,deadline,
          max_requests,max_concurrent,max_request_bytes,max_output_bytes,max_tokens,request_count,state)
          SELECT $1,$2,'pre003-invocation','attempt-a','{}',$3,1,'mimo-test',$4,'binding-fixture',1,0,c.issuer,f.fence,
            clock_timestamp()+interval '1 hour',4,1,4096,8192,5000,1,'open'
          FROM ag_kernel.consumers c JOIN ag_kernel.policy_fences f ON f.consumer=c.consumer WHERE c.consumer=$1`,
        [c, nativeLegacy.execution, nativeLegacy.account, nativeLegacy.generation]);
        await admin.query(`INSERT INTO ag_kernel.requests(consumer,execution_ref,id,effect,worker,closure_token)
          VALUES ($1,$2,'pre003','completed',$3,$4)`,
        [c, nativeLegacy.execution, nativeLegacy.worker, nativeLegacy.token]);
      }
      if (name.startsWith('004_')) await seedRecoveryHistory();
    }
    migrated = true;
    a = new PostgresKernel(poolA);
    b = new PostgresKernel(poolB);
    pids = await Promise.all([poolA, poolB].map(async pool => (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    assert.notEqual(pids[0], pids[1], 'race must use distinct real DB connections');
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error('disposable PostgreSQL setup failed; inspect server locally without exporting vendor details');
  }
});
after(async () => {
  // Leave the disposable DB schema for exact-candidate inspection; never DROP.
  await Promise.all([admin, poolA, poolB].filter(Boolean).map(pool => pool.end()));
});

// Controlled trusted callback fixtures; no native process/provider is launched.
const reservation = (): NativeReservation => ({
  originRef: 'sandbox-native-origin', engineIncarnation: randomUUID(), requestNonce: randomUUID(),
});
const nativeLegacy = { ctx: { consumerId: 'native-legacy-' + randomUUID() },
  account: '', execution: '', worker: '', generation: '', token: randomUUID() };
const context = (): TrustedContext => ({ consumerId: 'test-' + randomUUID() });
const op = (): string => randomUUID();
const digest = (): string => 'safe-ingress-' + randomUUID();
const isCode = (code: string) => (e: unknown): boolean => e instanceof KernelError && e.code === code;
async function worker(ctx: TrustedContext, kernel = a): Promise<string> {
  const id = randomUUID(); await kernel.heartbeat(ctx, id); return id;
}
async function staged(ctx: TrustedContext, overrides: Partial<AccountIntent> = {}, kernel = a): Promise<OperationStatus> {
  return kernel.beginAccount(ctx, { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'workspace-fixture', profile: 'mimo-test', displayName: 'Disposable connection', ...overrides });
}
async function connected(ctx: TrustedContext, kernel = a): Promise<OperationStatus> {
  const s = await staged(ctx, {}, kernel); const w = await worker(ctx, kernel);
  const c = await kernel.startCandidate(ctx, s.operationRef, w); assert.ok(c);
  return kernel.acknowledgeCandidate(ctx, s.operationRef, w, {
    generation: c.candidate, nativePhysicalIdentity: randomUUID(), profile: c.profile,
  });
}
async function approval(ctx: TrustedContext, accountRef: string, override: Partial<ApprovedPreparation> = {}, kernel = a): Promise<ApprovedPreparation> {
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  return { operationId: op(), intentDigest: digest(), invocationRef: op(), attemptRef: 'attempt-a',
    permittedAccounts: [accountRef], profile: 'mimo-test', policySubject: 'binding-fixture', policyRevision: 1, bindingRevision: 0,
    issuerEpoch: await kernel.issuer(ctx), deadline: new Date(now.getTime() + 60_000),
    limits: { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 }, ...override };
}
function admissionFor(input: ApprovedPreparation, result: OperationStatus, accountRef: string): PrivateAdmission {
  return { executionRef: result.executionRef!, accountRef, subjectRef: input.policySubject,
    invocationRef: input.invocationRef, attemptRef: input.attemptRef, profileId: input.profile,
    issuerEpoch: input.issuerEpoch, authorizationEpoch: result.epoch!, policyRevision: input.policyRevision,
    bindingRevision: input.bindingRevision, limits: { ...input.limits }, expiresAt: input.deadline.toISOString() };
}
async function prepared(ctx: TrustedContext, accountRef: string, override: Partial<ApprovedPreparation> = {}, kernel = a) {
  const input = await approval(ctx, accountRef, override, kernel);
  const result = await kernel.prepare(ctx, input); assert.ok(result.executionRef); assert.ok(result.epoch);
  return { input, result, admission: admissionFor(input, result, accountRef) };
}
// Bounded observation tolerates a busy runner without retrying any kernel action.
async function waitForLocks(db: pg.PoolClient, expected: number[]): Promise<boolean> {
  const until = process.hrtime.bigint() + 15_000_000_000n;
  while (process.hrtime.bigint() < until) {
    // The barrier transaction must not retain an earlier idle activity snapshot.
    await db.query('SELECT pg_stat_clear_snapshot()');
    const seen = await db.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND wait_event_type='Lock'", [expected]);
    if (seen.rows[0].n === expected.length) return true;
    await delay(20);
  }
  return false;
}
// Hold the authoritative row; observe BOTH live sessions blocked before release.
// This catches check-then-insert/check-then-dispatch regressions under contention.
async function race<L, R>(ctx: TrustedContext, left: () => Promise<L>, right: () => Promise<R>) {
  await a.issuer(ctx);
  const gate = await admin.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [ctx.consumerId]);
    const pair = Promise.allSettled([left(), right()]);
    const blocked = await waitForLocks(gate, pids);
    await gate.query('COMMIT');
    const results = await pair;
    assert.equal(blocked, true, 'both distinct sessions must reach the DB barrier');
    return results;
  } finally { await gate.query('ROLLBACK'); gate.release(); }
}
async function mutateAtConsumerLock<T>(ctx: TrustedContext, action: () => Promise<T>, mutate: () => void): Promise<T> {
  await a.issuer(ctx);
  const gate = await admin.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [ctx.consumerId]);
    const pending = Promise.allSettled([action()]);
    const blocked = await waitForLocks(gate, [pids[0]]);
    if (blocked) mutate();
    await gate.query('COMMIT');
    const [outcome] = await pending;
    assert.equal(blocked, true, 'command session must reach the actual consumer-row barrier');
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  } finally { await gate.query('ROLLBACK'); gate.release(); }
}
async function count(sql: string, values: unknown[]) {
  const n = Number((await admin.query(sql, values)).rows[0].n);
  assert.ok(Number.isSafeInteger(n) && n >= 0);
  return n;
}

// Spare concurrency must not admit a fresh ID before maintenance observes owner loss.
test('worker slot growth prepays retained identities without rewriting accepted history', async () => {
  const ctx = context();
  const facts = { ...factDefaults, workerSlots: 2, issuerSlots: 3, maxConsumerFacts: 96, maxAccountFacts: 96 };
  const small = new PostgresKernel(poolA, defaults, facts);
  const stagedAccount = await small.beginAccount(ctx, { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'workspace-fixture', profile: 'mimo-test', displayName: 'Retained slot account' });
  const candidateWorker = await worker(ctx, small);
  const candidate = await small.startCandidate(ctx, stagedAccount.operationRef, candidateWorker); assert.ok(candidate);
  const account = await small.acknowledgeCandidate(ctx, stagedAccount.operationRef, candidateWorker, {
    generation: candidate.candidate, nativePhysicalIdentity: randomUUID(), profile: candidate.profile,
  });
  const requestWorker = await worker(ctx, small);
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const input: ApprovedPreparation = { operationId: op(), intentDigest: digest(), invocationRef: op(), attemptRef: 'attempt-a',
    permittedAccounts: [account.accountRef!], profile: 'mimo-test', policySubject: 'binding-fixture', policyRevision: 1,
    bindingRevision: 0, issuerEpoch: await small.issuer(ctx), deadline: new Date(now.getTime() + 60_000),
    limits: { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 } };
  const execution = await small.prepare(ctx, input);
  const claim = await small.claim(ctx, execution.executionRef!, 'retained-unknown', requestWorker,
    admissionFor(input, execution, account.accountRef!), reservation()); assert.ok(claim.dispatch);
  await small.effect(ctx, execution.executionRef!, 'retained-unknown', requestWorker, 'effect_unknown');
  // Both expired owners remain referenced by normal candidate/request history.
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1", [ctx.consumerId]);
  const snapshot = async () => {
    const rows = (await admin.query(`SELECT c.worker_slots,c.fact_used,c.fact_limit,c.account_fact_limit,b.used,b.capacity,
      (SELECT fact_used FROM ag_kernel.accounts WHERE consumer=c.consumer AND ref=$2) AS account_used
      FROM ag_kernel.consumers c CROSS JOIN ag_kernel.fact_budget b WHERE c.consumer=$1`, [ctx.consumerId, account.accountRef])).rows[0];
    const history: Record<string, string[]> = {};
    for (const table of ['accounts', 'operations', 'candidates', 'executions', 'requests', 'cleanup']) {
      history[table] = (await admin.query(`SELECT row_to_json(t)::text AS row FROM ag_kernel.${table} t WHERE consumer=$1`,
        [ctx.consumerId])).rows.map(row => row.row as string).sort();
    }
    return { ...rows, history };
  };
  const before = await snapshot();
  const grown = new PostgresKernel(poolB, defaults, { ...facts, workerSlots: 3 });
  const replacement = await worker(ctx, grown);
  const afterGrowth = await snapshot();
  assert.equal(afterGrowth.worker_slots, 3);
  assert.equal(Number(afterGrowth.fact_used), Number(before.fact_used) + 1);
  assert.equal(Number(afterGrowth.used), Number(before.used) + 1);
  assert.equal(afterGrowth.account_used, before.account_used);
  assert.deepEqual(afterGrowth.history, before.history);
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.workers WHERE consumer=$1', [ctx.consumerId]), 3);
  await grown.issuer(ctx); await grown.heartbeat(ctx, replacement); await small.issuer(ctx);
  assert.deepEqual(await snapshot(), afterGrowth, 'same or lower desired capacity never charges twice or refunds history');
  const saturated = new PostgresKernel(poolB, defaults, { ...facts, workerSlots: 4,
    maxServiceFacts: Number(afterGrowth.used) + 1,
    maxConsumerFacts: Number(afterGrowth.fact_used), maxAccountFacts: Number(afterGrowth.fact_used) });
  await assert.rejects(saturated.issuer(ctx), isCode('denied'));
  assert.deepEqual(await snapshot(), afterGrowth, 'denied growth rolls back both quota tightening and slot update');
});

test('F1 claim fences expired in-flight ownership before spare-concurrency admission', async () => {
  const bounds = { ...defaults, maxConcurrent: 2, maintenanceBatch: 1 };
  const kernel = new PostgresKernel(poolA, bounds);
  const ctx = context(), account = await connected(ctx);
  const limits = { requests: 4, concurrency: 2, requestBytes: 4096, outputBytes: 8192, tokens: 5000 };
  const e = await prepared(ctx, account.accountRef!, { limits }, kernel);
  const unrelated = await prepared(ctx, account.accountRef!, { limits }, kernel);
  const w1 = await worker(ctx), w2 = await worker(ctx);
  const completed = await kernel.claim(ctx, e.result.executionRef!, 'completed', w1, e.admission, reservation()); assert.ok(completed.dispatch);
  await kernel.effect(ctx, e.result.executionRef!, 'completed', w1, 'response_started');
  await kernel.effect(ctx, e.result.executionRef!, 'completed', w1, 'completed');
  await kernel.acknowledgeTransportClosed(ctx, w1, completed.dispatch.closure);
  const R1 = await kernel.claim(ctx, e.result.executionRef!, 'R1', w1, e.admission, reservation()); assert.ok(R1.dispatch);
  assert.ok((await kernel.claim(ctx, unrelated.result.executionRef!, 'live', w2, unrelated.admission, reservation())).dispatch);
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
    [ctx.consumerId, w1]);
  // No effect/reconcile/restore between exact W1 expiry and the fresh W2 claim.
  const denied = await kernel.claim(ctx, e.result.executionRef!, 'R2', w2, e.admission, reservation());
  assert.deepEqual(denied, { status: { requestRef: 'R2', effect: 'not_dispatched', code: 'fenced' } });
  assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'R2'), denied.status);
  assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'R1'),
    { requestRef: 'R1', effect: 'effect_unknown', code: 'owner_lost' });
  assert.equal((await b.execution(ctx, e.result.executionRef!)).state, 'fenced');
  assert.equal((await b.request(ctx, e.result.executionRef!, 'completed')).effect, 'completed');
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 2);
  assert.deepEqual(await kernel.claim(ctx, e.result.executionRef!, 'R2', w2, e.admission, reservation()), denied);
  assert.equal((await kernel.claim(ctx, e.result.executionRef!, 'R1', w2, e.admission, reservation())).dispatch, undefined);
  const replay = await kernel.prepare(ctx, { ...e.input, operationId: op() });
  assert.equal(replay.executionRef, e.result.executionRef);
  const fresh = await kernel.claim(ctx, replay.executionRef!, 'R3', w2, e.admission, reservation());
  assert.equal(fresh.dispatch, undefined); assert.equal(fresh.status.code, 'fenced');
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2',
    [ctx.consumerId, e.result.executionRef]), 1);
  assert.equal((await b.execution(ctx, unrelated.result.executionRef!)).state, 'open');
  assert.equal((await b.request(ctx, unrelated.result.executionRef!, 'live')).effect, 'dispatch_started');
  await kernel.acknowledgeTransportClosed(ctx, w1, R1.dispatch.closure);
  assert.equal((await b.request(ctx, e.result.executionRef!, 'R1')).effect, 'effect_unknown');
  assert.ok((await kernel.claim(ctx, unrelated.result.executionRef!, 'live-next', w2, unrelated.admission, reservation())).dispatch);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2',
    [ctx.consumerId, unrelated.result.executionRef]), 0);
});

test('F2 beginAccount snapshots caller primitives before the consumer-row await', async () => {
  const ctx = context();
  const input: AccountIntent = { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'owner', profile: 'mimo-test', displayName: 'A' };
  const original = { ...input };
  const result = await mutateAtConsumerLock(ctx, () => a.beginAccount(ctx, input), () => { input.displayName = 'B'; });
  assert.equal(result.operationRef, original.operationId);
  assert.equal((await b.account(ctx, result.accountRef!)).displayName, 'A');
  assert.deepEqual(await b.operation(ctx, original.operationId), result);
  assert.deepEqual(await b.beginAccount(ctx, original), result);
  await assert.rejects(b.beginAccount(ctx, input), isCode('conflict'));
  const recorded = (await admin.query('SELECT intent FROM ag_kernel.operations WHERE consumer=$1 AND id=$2',
    [ctx.consumerId, original.operationId])).rows[0].intent;
  assert.deepEqual(recorded, { kind: 'create', digest: original.intentDigest, target: null,
    expectedRevision: null, owner: original.ownerRef, profile: original.profile, name: 'A' });
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.accounts WHERE consumer=$1', [ctx.consumerId]), 1);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.candidates WHERE consumer=$1', [ctx.consumerId]), 1);
});

test('F3 acknowledgeCandidate snapshots native proof before the consumer-row await', async () => {
  const ctx = context(), account = await staged(ctx), w = await worker(ctx);
  const candidate = await a.startCandidate(ctx, account.operationRef, w); assert.ok(candidate);
  const initial = (await admin.query('SELECT native_identity FROM ag_kernel.candidates WHERE consumer=$1 AND generation=$2',
    [ctx.consumerId, candidate.candidate])).rows[0];
  assert.equal(initial.native_identity, null, 'fresh candidate has no acknowledged physical identity');
  const proof = { generation: candidate.candidate, nativePhysicalIdentity: randomUUID(), profile: candidate.profile };
  const original = { ...proof }, differentIdentity = randomUUID();
  const result = await mutateAtConsumerLock(ctx,
    () => a.acknowledgeCandidate(ctx, account.operationRef, w, proof),
    () => { proof.nativePhysicalIdentity = differentIdentity; });
  assert.equal(result.state, 'applied');
  const recorded = (await admin.query('SELECT generation,native_identity AS "nativePhysicalIdentity",profile FROM ag_kernel.candidates WHERE consumer=$1 AND generation=$2',
    [ctx.consumerId, candidate.candidate])).rows[0];
  assert.deepEqual(recorded, original);
  const e = await prepared(ctx, account.accountRef!);
  const claim = await b.claim(ctx, e.result.executionRef!, 'proof-snapshot', w, e.admission, reservation());
  assert.ok(claim.dispatch);
  assert.deepEqual(claim.dispatch.descriptor, original);
  assert.deepEqual(await b.acknowledgeCandidate(ctx, account.operationRef, w, original), result);
  await assert.rejects(b.acknowledgeCandidate(ctx, account.operationRef, w, proof), isCode('conflict'));
});

test('transaction snapshots trusted consumer before awaits despite structurally mutable context', async () => {
  const original = context(), foreign = context();
  await connected(foreign);
  const before = await b.accounts(foreign);
  const caller = { consumerId: original.consumerId };
  const input: AccountIntent = { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'owner', profile: 'mimo-test', displayName: 'Consumer A' };
  const result = await mutateAtConsumerLock(original, () => a.beginAccount(caller, input),
    () => { caller.consumerId = foreign.consumerId; });
  assert.equal((await b.account(original, result.accountRef!)).displayName, 'Consumer A');
  assert.deepEqual(await b.operation(original, input.operationId), result);
  assert.deepEqual(await b.beginAccount(original, input), result);
  await assert.rejects(b.operation(foreign, input.operationId), isCode('unknown'));
  await assert.rejects(b.account(foreign, result.accountRef!), isCode('unknown'));
  assert.deepEqual(await b.accounts(foreign), before);
  for (const table of ['accounts', 'operations', 'candidates', 'issuer_epochs']) {
    assert.equal(await count(`SELECT count(*)::integer n FROM ag_kernel.${table} WHERE consumer=$1`, [original.consumerId]), 1, table);
    assert.equal(await count(`SELECT count(*)::integer n FROM ag_kernel.${table} WHERE consumer=$1`, [foreign.consumerId]), 1, table);
  }
});

// Red if concurrent id reuse creates two account rows/candidates, changes the
// lost-ack reference, or a second native-create permit can escape.
test('operation/candidate uniqueness and conflicting intent across connections', async () => {
  assert.equal(migrated, true);
  const ctx = context();
  const input: AccountIntent = { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'owner', profile: 'mimo-test', displayName: 'Disposable' };
  const results = await race(ctx, () => a.beginAccount(ctx, input), () => b.beginAccount(ctx, input));
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'fulfilled');
  if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') return;
  assert.deepEqual(results[0].value, results[1].value);
  assert.equal(results[0].value.operationRef, input.operationId);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.candidates WHERE consumer=$1', [ctx.consumerId]), 1);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.accounts WHERE consumer=$1', [ctx.consumerId]), 1);
  await assert.rejects(b.beginAccount(ctx, { ...input, intentDigest: digest() }), isCode('conflict'));
  await assert.rejects(b.beginAccount(ctx, { ...input, ownerRef: 'other' }), isCode('conflict'));
  const w1 = await worker(ctx, a), w2 = await worker(ctx, b);
  const starts = await race(ctx, () => a.startCandidate(ctx, input.operationId, w1), () => b.startCandidate(ctx, input.operationId, w2));
  assert.equal(starts.filter(r => r.status === 'fulfilled' && r.value !== undefined).length, 1);
  const winner = starts.find(r => r.status === 'fulfilled' && r.value !== undefined);
  assert.ok(winner && winner.status === 'fulfilled');
  const candidate = winner.value; assert.ok(candidate);
  const owner = starts[0].status === 'fulfilled' && starts[0].value ? w1 : w2;
  await a.unknownCandidate(ctx, input.operationId, owner);
  assert.equal((await b.operation(ctx, input.operationId)).state, 'unknown');
  assert.equal(await b.startCandidate(ctx, input.operationId, w2), undefined);
  assert.equal((await a.account(ctx, results[0].value.accountRef!)).state, 'quarantined');
  const inert = await staged(ctx);
  await a.beginAccount(ctx, { operationId: op(), kind: 'disable', intentDigest: digest(),
    accountRef: inert.accountRef, expectedRevision: 1 });
  assert.equal((await b.operation(ctx, inert.operationRef)).state, 'rejected');
  assert.equal(await b.startCandidate(ctx, inert.operationRef, w2), undefined);
});

// Red if two different intents both succeed for the same id after racing a
// preflight check, even though sequential conflict tests would still pass.
test('concurrent conflicting operation intent has exactly one winner', async () => {
  const ctx = context(), id = op();
  const input: AccountIntent = { operationId: id, kind: 'create', intentDigest: digest(),
    ownerRef: 'owner', profile: 'mimo-test', displayName: 'One' };
  const results = await race(ctx, () => a.beginAccount(ctx, input), () => b.beginAccount(ctx, { ...input, displayName: 'Two' }));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(isCode('conflict')(rejected.reason), true);
});

// Red if staging is executable, rename rotates authority, stage switches the
// active generation, or promotion loses a concurrent metadata revision.
test('staging, rename and reconnect use separate revision and epoch CAS', async () => {
  const ctx = context(), s = await staged(ctx);
  await assert.rejects(a.prepare(ctx, await approval(ctx, s.accountRef!)), isCode('unknown'));
  const w = await worker(ctx), c = await a.startCandidate(ctx, s.operationRef, w); assert.ok(c);
  const active = await a.acknowledgeCandidate(ctx, s.operationRef, w,
    { generation: c.candidate, nativePhysicalIdentity: randomUUID(), profile: c.profile });
  const e = await prepared(ctx, active.accountRef!);
  await assert.rejects(b.beginAccount(ctx, { operationId: op(), kind: 'rename', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: 0, displayName: 'Zero is a revision, not a count' }), isCode('conflict'));
  const rename = await a.beginAccount(ctx, { operationId: op(), kind: 'rename', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: active.revision, displayName: 'Renamed' });
  assert.equal(rename.epoch, active.epoch);
  const reconnect = await a.beginAccount(ctx, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: rename.revision });
  const pending = await a.startCandidate(ctx, reconnect.operationRef, w); assert.ok(pending);
  const oldClaim = await b.claim(ctx, e.result.executionRef!, 'old-before-promotion', w, e.admission, reservation());
  assert.ok(oldClaim.dispatch);
  assert.equal(oldClaim.dispatch.descriptor.generation, c.candidate);
  const promoted = await a.acknowledgeCandidate(ctx, reconnect.operationRef, w,
    { generation: pending.candidate, nativePhysicalIdentity: randomUUID(), profile: pending.profile });
  assert.equal(promoted.epoch, active.epoch! + 1);
  const denied = await b.claim(ctx, e.result.executionRef!, 'old-after-promotion', w, e.admission, reservation());
  assert.equal(denied.dispatch, undefined); assert.equal(denied.status.effect, 'not_dispatched');
  const e2 = await prepared(ctx, active.accountRef!, { invocationRef: op() });
  const stale = await a.beginAccount(ctx, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: promoted.revision });
  const sc = await a.startCandidate(ctx, stale.operationRef, w); assert.ok(sc);
  const renamed = await a.beginAccount(ctx, { operationId: op(), kind: 'rename', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: promoted.revision, displayName: 'CAS winner' });
  const staleProof = { generation: sc.candidate, nativePhysicalIdentity: randomUUID(), profile: sc.profile };
  const lost = await a.acknowledgeCandidate(ctx, stale.operationRef, w, staleProof);
  assert.equal(lost.state, 'unknown'); assert.equal(lost.code, 'revision_conflict');
  const retained = await a.account(ctx, active.accountRef!);
  assert.equal(retained.revision, renamed.revision); assert.equal(retained.displayName, 'CAS winner');
  assert.equal(retained.epoch, promoted.epoch); assert.equal(retained.state, 'active');
  const route = (await admin.query('SELECT active_generation FROM ag_kernel.accounts WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, active.accountRef])).rows[0];
  assert.equal(route.active_generation, pending.candidate, 'stale reconnect cannot replace the old active generation');
  const staleCandidate = (await admin.query('SELECT state,native_identity FROM ag_kernel.candidates WHERE consumer=$1 AND generation=$2',
    [ctx.consumerId, sc.candidate])).rows[0];
  assert.equal(staleCandidate.state, 'quarantined'); assert.equal(staleCandidate.native_identity, staleProof.nativePhysicalIdentity);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND generation=$2',
    [ctx.consumerId, sc.candidate]), 1);
  assert.deepEqual(await b.acknowledgeCandidate(ctx, stale.operationRef, w, staleProof), lost);
  assert.equal(await b.startCandidate(ctx, stale.operationRef, w), undefined);
  await a.effect(ctx, e.result.executionRef!, 'old-before-promotion', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'old-before-promotion', w, 'completed');
  await a.acknowledgeTransportClosed(ctx, w, oldClaim.dispatch.closure);
  const still = await a.claim(ctx, e2.result.executionRef!, 'still-sticky', w, e2.admission, reservation());
  assert.ok(still.dispatch); assert.equal(still.dispatch.descriptor.generation, pending.candidate);
});

// Red if a stale admitted envelope dispatches after the acknowledged fence,
// or fencing rewrites an already accepted effect.
test('fence linearizes against claim and preserves already accepted effects', async () => {
  const ctx = context(), account = await connected(ctx), e = await prepared(ctx, account.accountRef!);
  const w = await worker(ctx);
  const first = await a.claim(ctx, e.result.executionRef!, 'accepted', w, e.admission, reservation()); assert.ok(first.dispatch);
  const f = await b.fence(ctx, 'fence-stable', e.input.policySubject, 2); assert.equal(f.state, 'applied');
  const stale = await a.claim(ctx, e.result.executionRef!, 'paused-envelope', w, e.admission, reservation());
  assert.equal(stale.status.effect, 'not_dispatched'); assert.equal(stale.dispatch, undefined);
  assert.equal((await b.request(ctx, e.result.executionRef!, 'accepted')).effect, 'dispatch_started');
  await a.effect(ctx, e.result.executionRef!, 'accepted', w, 'response_started');
  assert.equal((await a.effect(ctx, e.result.executionRef!, 'accepted', w, 'completed')).effect, 'completed');
  assert.deepEqual(await b.fence(ctx, 'fence-stable', e.input.policySubject, 2), f);
  // Both transactions reach real DB contention. Either ordering is legal;
  // an accepted winner remains accepted, and every post-ack claim is denied.
  const ctx2 = context(), ac2 = await connected(ctx2), e2 = await prepared(ctx2, ac2.accountRef!), w2 = await worker(ctx2);
  const pair = await race(ctx2,
    () => a.fence(ctx2, op(), e2.input.policySubject, 2),
    () => b.claim(ctx2, e2.result.executionRef!, 'racing', w2, e2.admission, reservation()));
  assert.equal(pair.every(r => r.status === 'fulfilled'), true);
  const after = await a.claim(ctx2, e2.result.executionRef!, 'after-ack', w2, e2.admission, reservation());
  assert.equal(after.dispatch, undefined); assert.equal(after.status.effect, 'not_dispatched');
  // A distinct same-revision fence still closes previously issued admissions;
  // revision equality must never produce a false acknowledged fence.
  const ctx3 = context(), ac3 = await connected(ctx3), e3 = await prepared(ctx3, ac3.accountRef!), w3 = await worker(ctx3);
  assert.equal((await b.fence(ctx3, 'same-revision', e3.input.policySubject, 1)).state, 'applied');
  assert.equal((await a.claim(ctx3, e3.result.executionRef!, 'previously-issued', w3, e3.admission, reservation())).dispatch, undefined);
});

// Red if duplicate POST creates another dispatch permit, alternate preparation
// switches accounts, or fresh ids escape uncertainty on an invocation/attempt.
test('sticky preparation, duplicate requests and unknown invocation fencing', async () => {
  const ctx = context(), one = await connected(ctx), two = await connected(ctx);
  const input = await approval(ctx, one.accountRef!);
  const prep = await race(ctx, () => a.prepare(ctx, input), () => b.prepare(ctx, { ...input, operationId: 'parallel-prep' }));
  assert.equal(prep.every(r => r.status === 'fulfilled'), true);
  const e = await a.prepare(ctx, input);
  const again = await b.prepare(ctx, { ...input, operationId: 'another-prep' });
  assert.equal(again.executionRef, e.executionRef);
  await assert.rejects(b.prepare(ctx, { ...input, operationId: op(), permittedAccounts: [two.accountRef!] }), isCode('conflict'));
  const w1 = await worker(ctx, a), w2 = await worker(ctx, b);
  const admission = admissionFor(input, e, one.accountRef!);
  const claims = await race(ctx, () => a.claim(ctx, e.executionRef!, 'same-request', w1, admission, reservation()),
    () => b.claim(ctx, e.executionRef!, 'same-request', w2, admission, reservation()));
  assert.equal(claims.every(r => r.status === 'fulfilled'), true);
  assert.equal(claims.filter(r => r.status === 'fulfilled' && r.value.dispatch).length, 1);
  const winner = claims[0].status === 'fulfilled' && claims[0].value.dispatch ? w1 : w2;
  const duplicate = await b.claim(ctx, e.executionRef!, 'same-request', w2, admission, reservation());
  assert.equal(duplicate.dispatch, undefined); assert.equal(duplicate.status.requestRef, 'same-request');
  await a.effect(ctx, e.executionRef!, 'same-request', winner, 'response_started');
  await b.effect(ctx, e.executionRef!, 'same-request', winner, 'effect_unknown');
  const fresh = await a.claim(ctx, e.executionRef!, op(), w1, admission, reservation());
  assert.equal(fresh.dispatch, undefined); assert.equal(fresh.status.effect, 'not_dispatched');
  assert.equal((await b.prepare(ctx, { ...input, operationId: op() })).executionRef, e.executionRef);
  await assert.rejects(a.prepare(ctx, { ...input, operationId: op(), intentDigest: digest() }), isCode('conflict'));
  await assert.rejects(a.prepare(ctx, { ...input, operationId: op(), deadline: new Date(input.deadline.getTime()+1_000) }), isCode('conflict'));
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.executions WHERE consumer=$1', [ctx.consumerId]), 1);
});

// Red if concurrency/total limits are preflight-only, denial can later dispatch
// using the same request id, or runtime numeric/deadline checks are only types.
test('atomic request limits and runtime deadline/config enforcement', async () => {
  const ctx = context(), account = await connected(ctx);
  const e = await prepared(ctx, account.accountRef!, { limits: { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 } });
  const w = await worker(ctx);
  const other = await prepared(ctx, account.accountRef!);
  const misbound = await b.claim(ctx, other.result.executionRef!, 'wrong-envelope', w, e.admission, reservation());
  assert.equal(misbound.dispatch, undefined); assert.equal(misbound.status.code, 'fenced');
  const pair = await race(ctx, () => a.claim(ctx, e.result.executionRef!, 'one', w, e.admission, reservation()),
    () => b.claim(ctx, e.result.executionRef!, 'two', w, e.admission, reservation()));
  assert.equal(pair.every(r => r.status === 'fulfilled'), true);
  assert.equal(pair.filter(r => r.status === 'fulfilled' && r.value.dispatch).length, 1);
  const first = pair[0].status === 'fulfilled' && pair[0].value.dispatch ? 'one' : 'two';
  const denied = first === 'one' ? 'two' : 'one';
  const deniedClaim = pair.find(r => r.status === 'fulfilled' && !r.value.dispatch);
  assert.ok(deniedClaim && deniedClaim.status === 'fulfilled');
  assert.equal(deniedClaim.value.status.code, 'concurrency_limit');
  assert.equal(deniedClaim.value.status.effect, 'not_dispatched');
  const accountBusy = await b.claim(ctx, other.result.executionRef!, 'account-busy', w, other.admission, reservation());
  assert.equal(accountBusy.dispatch, undefined);
  assert.equal(accountBusy.status.code, 'concurrency_limit');
  assert.equal(accountBusy.status.effect, 'not_dispatched');
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, other.result.executionRef]), 0);
  await assert.rejects(a.effect(ctx, e.result.executionRef!, first, w, 'completed'), isCode('conflict'));
  await a.effect(ctx, e.result.executionRef!, first, w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, first, w, 'completed');
  const permit = pair.find(r => r.status === 'fulfilled' && r.value.dispatch);
  assert.ok(permit && permit.status === 'fulfilled' && permit.value.dispatch);
  await a.acknowledgeTransportClosed(ctx, w, permit.value.dispatch.closure);
  assert.equal((await b.claim(ctx, e.result.executionRef!, denied, w, e.admission, reservation())).dispatch, undefined);
  assert.deepEqual(await b.claim(ctx, other.result.executionRef!, 'account-busy', w, other.admission, reservation()), accountBusy);
  const third = await a.claim(ctx, e.result.executionRef!, 'third', w, e.admission, reservation()); assert.ok(third.dispatch);
  await a.effect(ctx, e.result.executionRef!, 'third', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'third', w, 'completed');
  await a.acknowledgeTransportClosed(ctx, w, third.dispatch.closure);
  const accountFreed = await b.claim(ctx, other.result.executionRef!, 'account-freed', w, other.admission, reservation());
  assert.ok(accountFreed.dispatch);
  const total = await b.claim(ctx, e.result.executionRef!, 'fourth', w, e.admission, reservation());
  // The original request quota wins even while the same account is occupied.
  assert.equal(total.status.code, 'limit'); assert.equal(total.status.effect, 'not_dispatched');
  await b.effect(ctx, other.result.executionRef!, 'account-freed', w, 'response_started');
  await b.effect(ctx, other.result.executionRef!, 'account-freed', w, 'completed');
  await b.acknowledgeTransportClosed(ctx, w, accountFreed.dispatch.closure);
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!, { limits: { ...e.input.limits, requests: 0 } })), isCode('invalid'));
  // Red if pretransaction validation throws outside the Promise port or admits zero limits.
  await assert.rejects(b.prepare(ctx, await approval(ctx, account.accountRef!, { limits: { ...e.input.limits, concurrency: 0 } })), isCode('invalid'));
  await assert.rejects(a.account(ctx, 'invalid-uuid'), isCode('invalid'));
  await assert.rejects(b.restore(ctx, e.admission.issuerEpoch, e.admission.issuerEpoch), isCode('invalid'));
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!, { deadline: new Date(now.getTime() - 1) })), isCode('denied'));
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!, { deadline: new Date(now.getTime() + 3_700_000) })), isCode('denied'));
  const freshNow = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const short = await prepared(ctx, account.accountRef!, { deadline: new Date(freshNow.getTime() + 10_000) });
  const gate = await admin.connect();
  let expired;
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [ctx.consumerId]);
    const waiting = a.claim(ctx, short.result.executionRef!, 'late', w, short.admission, reservation());
    // Prevent an unhandled rejection while the actual transaction is blocked.
    const outcome = waiting.then(value => ({ value }), () => ({ value: undefined }));
    assert.equal(await waitForLocks(gate, [pids[0]]), true);
    await gate.query('SELECT pg_stat_clear_snapshot()');
    const started = (await gate.query('SELECT xact_start FROM pg_stat_activity WHERE pid=$1', [pids[0]])).rows[0].xact_start as Date;
    assert.ok(started.getTime() < short.input.deadline.getTime(), 'claim transaction must start before expiry');
    // Wait to the persisted DB deadline rather than a fixed wall-clock sleep.
    // CURRENT_TIMESTAMP would incorrectly accept this request after the wait.
    await gate.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)', [short.input.deadline]);
    assert.equal((await gate.query('SELECT clock_timestamp()>=$1::timestamptz AS expired', [short.input.deadline])).rows[0].expired, true);
    await gate.query('COMMIT');
    expired = (await outcome).value;
    assert.ok(expired);
  } finally { await gate.query('ROLLBACK'); gate.release(); }
  assert.equal(expired.status.code, 'deadline'); assert.equal(expired.dispatch, undefined);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2',
    [ctx.consumerId, short.result.executionRef]), 1);
});

// Expire the exact owner before maintenance. Stale callbacks must commit
// ambiguity/fencing, including same-state callbacks, and never allow replay.
test('expired effect owner cannot complete or retain in-flight authority before maintenance', async () => {
  const ctx = context(), account = await connected(ctx), live = await worker(ctx);
  for (const [state, next] of [
    ['dispatch_started', 'completed'], ['response_started', 'completed'],
    ['response_started', 'response_started'],
  ] as const) {
    const e = await prepared(ctx, account.accountRef!), lost = await worker(ctx);
    const permit = await a.claim(ctx, e.result.executionRef!, 'accepted', lost, e.admission, reservation()); assert.ok(permit.dispatch);
    if (state === 'response_started') await a.effect(ctx, e.result.executionRef!, 'accepted', lost, state);
    const expired = await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2", [ctx.consumerId, lost]);
    assert.equal(expired.rowCount, 1);
    // No reconcile/restore between lease expiry and this stale callback.
    const result = await a.effect(ctx, e.result.executionRef!, 'accepted', lost, next);
    assert.deepEqual(result, { requestRef: 'accepted', effect: 'effect_unknown', code: 'owner_lost' });
    assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'accepted'), result);
    assert.equal((await b.execution(ctx, e.result.executionRef!)).state, 'fenced');
    assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2', [ctx.consumerId, e.result.executionRef]), 1);
    assert.deepEqual(await b.effect(ctx, e.result.executionRef!, 'accepted', lost, 'effect_unknown'), result);
    await assert.rejects(b.effect(ctx, e.result.executionRef!, 'accepted', lost, 'completed'), isCode('conflict'));
    const duplicate = await b.claim(ctx, e.result.executionRef!, 'accepted', live, e.admission, reservation());
    assert.equal(duplicate.dispatch, undefined); assert.deepEqual(duplicate.status, result);
    const fresh = await b.claim(ctx, e.result.executionRef!, 'fresh', live, e.admission, reservation());
    assert.equal(fresh.dispatch, undefined); assert.equal(fresh.status.code, 'fenced');
    await b.reconcile(ctx);
    assert.deepEqual(await a.request(ctx, e.result.executionRef!, 'accepted'), result);
    await a.acknowledgeTransportClosed(ctx, lost, permit.dispatch.closure);
  }
  const completed = await prepared(ctx, account.accountRef!), owner = await worker(ctx);
  assert.ok((await a.claim(ctx, completed.result.executionRef!, 'done', owner, completed.admission, reservation())).dispatch);
  await a.effect(ctx, completed.result.executionRef!, 'done', owner, 'response_started');
  await a.effect(ctx, completed.result.executionRef!, 'done', owner, 'completed');
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2", [ctx.consumerId, owner]);
  assert.equal((await b.effect(ctx, completed.result.executionRef!, 'done', owner, 'completed')).effect, 'completed');
  await b.reconcile(ctx);
  assert.equal((await b.request(ctx, completed.result.executionRef!, 'done')).effect, 'completed');
  assert.equal((await b.claim(ctx, completed.result.executionRef!, 'done', live, completed.admission, reservation())).dispatch, undefined);
});

// Restore must persist cleanup for active, creating, staged and already
// quarantined generations, without inventing physical identity for unknowns.
test('restore durably cleans every exact generation and repeated restores do not duplicate work', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const foreign = context(), foreignAccount = await connected(foreign);
  const e = await prepared(ctx, account.accountRef!);
  assert.ok((await a.claim(ctx, e.result.executionRef!, 'done', w, e.admission, reservation())).dispatch);
  await a.effect(ctx, e.result.executionRef!, 'done', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'done', w, 'completed');
  const reconnect = await a.beginAccount(ctx, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: account.accountRef, expectedRevision: account.revision });
  assert.ok(await a.startCandidate(ctx, reconnect.operationRef, w));
  const inert = await staged(ctx), uncertain = await staged(ctx);
  assert.ok(await a.startCandidate(ctx, uncertain.operationRef, w));
  await a.unknownCandidate(ctx, uncertain.operationRef, w);
  const rows = (await admin.query('SELECT generation,native_identity,profile,state FROM ag_kernel.candidates WHERE consumer=$1', [ctx.consumerId])).rows;
  assert.deepEqual(rows.map(r => r.state).sort(), ['creating','quarantined','ready','staged']);
  const expected = new Map(rows.map(r => [r.generation as string, r]));
  const original = await a.issuer(ctx), first = randomUUID(), second = randomUUID();
  await a.restore(ctx, original, first);
  await b.restore(ctx, first, second);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1', [ctx.consumerId]), 5);
  assert.equal((await b.operation(ctx, reconnect.operationRef)).state, 'unknown');
  assert.equal((await b.operation(ctx, inert.operationRef)).state, 'unknown');
  const seen = new Set<string>(), jobs: CleanupClaim[] = []; let executionSeen = false;
  for (let n = 0; n < 5; n++) {
    const job = await b.claimCleanup(ctx, w); assert.ok(job);
    jobs.push(job);
    if (job.scope.kind === 'generation') {
      const scope = job.scope, row = expected.get(scope.generation); assert.ok(row);
      assert.equal(seen.has(scope.generation), false); seen.add(scope.generation);
      assert.equal(scope.profile, row.profile);
      if (row.native_identity) assert.deepEqual(scope.descriptor, {
        generation: row.generation, nativePhysicalIdentity: row.native_identity, profile: row.profile,
      });
      else assert.equal(scope.descriptor, undefined, 'unknown physical identity must remain absent');
      if (row.state === 'ready') {
        await assert.rejects(b.settleCleanup(ctx, job.cleanupRef, w, job.token, true), isCode('conflict'));
      }
    } else {
      assert.equal(executionSeen, false); executionSeen = true;
      assert.equal(job.scope.executionRef, e.result.executionRef);
    }
  }
  // UUID claim order cannot permit credential retirement ahead of a completed
  // request's still-held transport. Close the complete execution page first.
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  for (const job of jobs) await acknowledgeCleanupPage(ctx, b, job, w);
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  for (const job of jobs) {
    await b.settleCleanup(ctx, job.cleanupRef, w, job.token, true);
    await a.settleCleanup(ctx, job.cleanupRef, w, job.token, true);
  }
  assert.equal(seen.size, 4); assert.equal(executionSeen, true);
  assert.equal(await a.claimCleanup(ctx, w), undefined);
  assert.equal(await count("SELECT count(*)::integer n FROM ag_kernel.candidates WHERE consumer=$1 AND state='retired'", [ctx.consumerId]), 4);
  assert.equal((await a.account(ctx, account.accountRef!)).state, 'quarantined');
  assert.equal((await a.account(foreign, foreignAccount.accountRef!)).state, 'active');
  assert.equal((await a.request(ctx, e.result.executionRef!, 'done')).effect, 'completed');
  await a.restore(ctx, second, randomUUID());
  assert.equal(await count("SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND state='done'", [ctx.consumerId]), 5);
  assert.equal(await b.claimCleanup(ctx, w), undefined);
});

// Red if startup rotates all grants, expired ownership retries inference,
// incomplete candidates become active, or restore is treated like restart.
test('restart reconciles only lost claims; explicit restore rotates and quarantines', async () => {
  const ctx = context(), account = await connected(ctx);
  const separate = await connected(ctx);
  const healthy = await prepared(ctx, account.accountRef!), dead = await prepared(ctx, separate.accountRef!);
  const liveWorker = await worker(ctx), deadWorker = await worker(ctx);
  assert.ok((await a.claim(ctx, healthy.result.executionRef!, 'live', liveWorker, healthy.admission, reservation())).dispatch);
  assert.ok((await b.claim(ctx, dead.result.executionRef!, 'orphan', deadWorker, dead.admission, reservation())).dispatch);
  const pending = await staged(ctx), c = await a.startCandidate(ctx, pending.operationRef, deadWorker); assert.ok(c);
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
    [ctx.consumerId, deadWorker]);
  await poolA.end();
  poolA = new pg.Pool({ connectionString: safeTestDsn(), max: 1, idleTimeoutMillis: 0 });
  a = new PostgresKernel(poolA); // Real connection/pool replacement, no process-start revoke.
  pids[0] = (await poolA.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const originalIssuer = await a.issuer(ctx);
  await a.reconcile(ctx);
  assert.equal((await a.request(ctx, dead.result.executionRef!, 'orphan')).effect, 'effect_unknown');
  assert.equal((await a.request(ctx, healthy.result.executionRef!, 'live')).effect, 'dispatch_started');
  assert.equal((await a.execution(ctx, healthy.result.executionRef!)).state, 'open');
  assert.equal((await a.account(ctx, account.accountRef!)).state, 'active');
  assert.equal((await a.operation(ctx, pending.operationRef)).state, 'unknown');
  assert.equal(await a.startCandidate(ctx, pending.operationRef, liveWorker), undefined);
  assert.equal((await a.claim(ctx, dead.result.executionRef!, 'fresh-orphan-id', liveWorker, dead.admission, reservation())).dispatch, undefined);
  await assert.rejects(a.heartbeat(ctx, deadWorker), isCode('denied'));
  assert.equal(await a.issuer(ctx), originalIssuer);
  const freshIssuer = randomUUID();
  await b.restore(ctx, originalIssuer, freshIssuer);
  assert.equal(await a.issuer(ctx), freshIssuer);
  assert.equal((await a.account(ctx, account.accountRef!)).state, 'quarantined');
  assert.equal((await a.request(ctx, healthy.result.executionRef!, 'live')).effect, 'effect_unknown');
  // Historical applied operation acknowledgement survives restore and cannot reactivate a route.
  const proof = (await admin.query('SELECT generation,native_identity,profile FROM ag_kernel.candidates WHERE consumer=$1 AND operation_id=$2', [ctx.consumerId, account.operationRef])).rows[0];
  assert.equal((await a.acknowledgeCandidate(ctx, account.operationRef, liveWorker, { generation: proof.generation, nativePhysicalIdentity: proof.native_identity, profile: proof.profile })).state, 'applied');
  assert.equal((await a.account(ctx, account.accountRef!)).state, 'quarantined');
  assert.equal((await a.claim(ctx, healthy.result.executionRef!, 'old-grant', liveWorker, healthy.admission, reservation())).dispatch, undefined);
  await assert.rejects(a.restore(ctx, freshIssuer, originalIssuer), isCode('conflict'));
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!)), isCode('unknown'));
});

// Red if cleanup dies with capability/owner, two workers settle the same lease,
// a stale token settles reclaimed work, or cleanup reactivates a disabled account.
test('disable and idempotent close persist bounded scoped cleanup across worker loss', async () => {
  const ctx = context(), account = await connected(ctx), e = await prepared(ctx, account.accountRef!);
  const w1 = await worker(ctx), w2 = await worker(ctx);
  assert.ok((await a.claim(ctx, e.result.executionRef!, 'accepted', w1, e.admission, reservation())).dispatch);
  const disabled = await a.beginAccount(ctx, { operationId: 'disable', kind: 'disable', intentDigest: digest(),
    accountRef: account.accountRef, expectedRevision: account.revision });
  assert.equal(disabled.state, 'applied');
  assert.equal((await b.claim(ctx, e.result.executionRef!, 'denied', w2, e.admission, reservation())).dispatch, undefined);
  const closed = await a.close(ctx, 'close', e.result.executionRef!);
  assert.deepEqual(await b.close(ctx, 'close', e.result.executionRef!), closed);
  assert.equal((await a.request(ctx, e.result.executionRef!, 'accepted')).effect, 'dispatch_started');
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1', [ctx.consumerId]), 2);
  const pair = await race(ctx, () => a.claimCleanup(ctx, w1), () => b.claimCleanup(ctx, w2));
  assert.equal(pair.every(r => r.status === 'fulfilled' && r.value !== undefined), true);
  const j1 = pair[0].status === 'fulfilled' ? pair[0].value : undefined;
  const j2 = pair[1].status === 'fulfilled' ? pair[1].value : undefined;
  assert.ok(j1 && j2); assert.notEqual(j1.cleanupRef, j2.cleanupRef);
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2", [ctx.consumerId, w1]);
  await a.reconcile(ctx);
  await admin.query("UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",
    [ctx.consumerId, j1.cleanupRef]);
  const reclaimed = await b.claimCleanup(ctx, w2); assert.ok(reclaimed);
  assert.equal(reclaimed.cleanupRef, j1.cleanupRef); assert.notEqual(reclaimed.token, j1.token);
  await assert.rejects(a.settleCleanup(ctx, j1.cleanupRef, w1, j1.token, true), isCode('denied'));
  const remaining = [reclaimed, j2];
  for (const job of remaining) {
    await assert.rejects(b.settleCleanup(ctx, job.cleanupRef, w2, job.token, true), isCode('conflict'));
  }
  // Generation cleanup cannot erase ahead of its execution's exact closure.
  for (const job of remaining) await acknowledgeCleanupPage(ctx, b, job, w2);
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  for (const job of remaining) await b.settleCleanup(ctx, job.cleanupRef, w2, job.token, true);
  await b.settleCleanup(ctx, j2.cleanupRef, w2, j2.token, true);
  assert.equal((await a.account(ctx, account.accountRef!)).state, 'disabled');
  assert.equal(await a.claimCleanup(ctx, w2), undefined);
  assert.equal((await a.request(ctx, e.result.executionRef!, 'accepted')).effect, 'effect_unknown');
});

// Red if any consumer-less lookup leaks a reference/proof or owner can mutate.
// Positive public field checks are independent allowlists, not copied helpers.
test('consumer isolation, immutable owner and positive safe readback shapes', async () => {
  const ctx = context(), foreign = context(), account = await connected(ctx), e = await prepared(ctx, account.accountRef!);
  const w = await worker(ctx);
  await a.claim(ctx, e.result.executionRef!, 'request', w, e.admission, reservation());
  await assert.rejects(b.account(foreign, account.accountRef!), isCode('unknown'));
  await assert.rejects(b.account(foreign, randomUUID()), isCode('unknown'));
  await assert.rejects(b.operation(foreign, account.operationRef), isCode('unknown'));
  await assert.rejects(b.execution(foreign, e.result.executionRef!), isCode('unknown'));
  await assert.rejects(b.request(foreign, e.result.executionRef!, 'request'), isCode('unknown'));
  await assert.rejects(b.claim(foreign, e.result.executionRef!, 'new', w, e.admission, reservation()), isCode('unknown'));
  await assert.rejects(b.beginAccount(foreign, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: account.accountRef, expectedRevision: account.revision }), isCode('unknown'));
  // A DB contract catches future alternate adapters accidentally transferring ownership.
  let rejected = false;
  try { await admin.query("UPDATE ag_kernel.accounts SET owner_ref='other' WHERE consumer=$1 AND ref=$2", [ctx.consumerId, account.accountRef]); }
  catch { rejected = true; }
  assert.equal(rejected, true);
  assert.deepEqual(Object.keys(await a.account(ctx, account.accountRef!)).sort(),
    ['accountRef','displayName','epoch','ownerRef','profile','revision','state'].sort());
  assert.deepEqual(Object.keys(await a.operation(ctx, account.operationRef)).sort(),
    ['operationRef','state','accountRef','revision','epoch'].sort());
  assert.deepEqual(Object.keys(await b.request(ctx, e.result.executionRef!, 'request')).sort(), ['requestRef','effect'].sort());
  const native = (await admin.query('SELECT generation,native_identity,profile FROM ag_kernel.candidates WHERE consumer=$1 AND operation_id=$2',
    [ctx.consumerId, account.operationRef])).rows[0];
  await assert.rejects(a.acknowledgeCandidate(ctx, account.operationRef, w, {
    generation: native.generation, nativePhysicalIdentity: randomUUID(), profile: native.profile,
  }), isCode('conflict'));
  await assert.rejects(a.acknowledgeCandidate(ctx, account.operationRef, w, {
    generation: randomUUID(), nativePhysicalIdentity: native.native_identity, profile: native.profile,
  }), isCode('conflict'));
});

// One persisted permission, every independently meaningful envelope field. A
// validly shaped but stale approval must not acquire a native transport permit.
test('complete private admission matches persisted preparation, with zero revisions and instant expiry', async () => {
  // Permit both 1 and 2 only in this case so a different valid concurrency
  // reaches persisted-envelope matching instead of numeric validation.
  const bounds = { ...defaults, maxConcurrent: 2 };
  const a = new PostgresKernel(poolA, bounds), b = new PostgresKernel(poolB, bounds);
  const ctx = context(), account = await connected(ctx);
  const e = await prepared(ctx, account.accountRef!, { policyRevision: 0, bindingRevision: 0 }, a);
  const w = await worker(ctx);
  const mutations: [string, Partial<PrivateAdmission>][] = [
    ['execution', { executionRef: randomUUID() }], ['issuer', { issuerEpoch: randomUUID() }],
    ['invocation', { invocationRef: 'another-invocation' }], ['attempt', { attemptRef: 'attempt-b' }],
    ['account', { accountRef: randomUUID() }], ['epoch', { authorizationEpoch: e.result.epoch! + 1 }], ['zero-epoch', { authorizationEpoch: 0 }],
    ['subject', { subjectRef: 'another-subject' }], ['policy', { policyRevision: 1 }],
    ['binding', { bindingRevision: 1 }], ['profile', { profileId: 'other-profile' }],
    ['expiry', { expiresAt: new Date(e.input.deadline.getTime() + 1).toISOString() }],
    ['finer-expiry', { expiresAt: e.input.deadline.toISOString().replace('Z', '1Z') }],
    ['requests', { limits: { ...e.input.limits, requests: 5 } }],
    ['concurrency', { limits: { ...e.input.limits, concurrency: 2 } }],
    ['body', { limits: { ...e.input.limits, requestBytes: 4097 } }],
    ['output', { limits: { ...e.input.limits, outputBytes: 8193 } }],
    ['tokens', { limits: { ...e.input.limits, tokens: 5001 } }],
  ];
  for (const [name, mutation] of mutations) {
    const denied = await b.claim(ctx, e.result.executionRef!, 'stale-' + name, w, { ...e.admission, ...mutation }, reservation());
    assert.equal(denied.dispatch, undefined, name);
    assert.equal(denied.status.effect, 'not_dispatched', name);
    assert.equal(denied.status.code, 'fenced', name);
    assert.deepEqual(await a.request(ctx, e.result.executionRef!, 'stale-' + name), denied.status);
  }
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 0);
  // Same instant with a different RFC3339 spelling must work; string equality
  // would deny it. The permit carries persisted transport limits, never a body.
  const offset = new Date(e.input.deadline.getTime() + 3_600_000).toISOString().replace('Z', '000+01:00');
  const accepted = await a.claim(ctx, e.result.executionRef!, 'offset-expiry', w, { ...e.admission, expiresAt: offset }, reservation());
  assert.ok(accepted.dispatch);
  assert.deepEqual(accepted.dispatch.limits, { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 });
  assert.equal(accepted.dispatch.deadline, e.input.deadline.toISOString());
  // A denied identity cannot later become a dispatch when its envelope is fixed.
  assert.equal((await a.claim(ctx, e.result.executionRef!, 'stale-binding', w, e.admission, reservation())).dispatch, undefined);
  await b.fence(ctx, 'zero-revision-fence', e.input.policySubject, 0);
  await a.effect(ctx, e.result.executionRef!, 'offset-expiry', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'offset-expiry', w, 'completed');
  const repeat = await b.claim(ctx, e.result.executionRef!, 'offset-expiry', w, { ...e.admission, bindingRevision: 1 }, reservation());
  assert.equal(repeat.dispatch, undefined); assert.equal(repeat.status.effect, 'completed');
  assert.equal((await a.claim(ctx, e.result.executionRef!, 'after-zero-fence', w, e.admission, reservation())).dispatch, undefined);
});

// Protect operation intent and sticky invocation identity independently. Each
// changed limit/revision must conflict even under a new operation reference.
test('preparation intent protects every approved limit and independent binding revision', async () => {
  // Both concurrency values must be in range to exercise operation and sticky
  // intent conflicts. Other cases retain the production default bound of 1.
  const bounds = { ...defaults, maxConcurrent: 2 };
  const a = new PostgresKernel(poolA, bounds), b = new PostgresKernel(poolB, bounds);
  const ctx = context(), account = await connected(ctx);
  const e = await prepared(ctx, account.accountRef!, { policyRevision: Number.MAX_SAFE_INTEGER, bindingRevision: Number.MAX_SAFE_INTEGER }, a);
  const changes: Partial<ApprovedPreparation>[] = [
    { bindingRevision: Number.MAX_SAFE_INTEGER - 1 }, { policyRevision: Number.MAX_SAFE_INTEGER - 1 },
    { policySubject: 'another-subject' }, { profile: 'another-profile' }, { issuerEpoch: randomUUID() },
    { deadline: new Date(e.input.deadline.getTime() + 1) },
    { limits: { ...e.input.limits, requests: 5 } }, { limits: { ...e.input.limits, concurrency: 2 } },
    { limits: { ...e.input.limits, requestBytes: 4097 } }, { limits: { ...e.input.limits, outputBytes: 8193 } },
    { limits: { ...e.input.limits, tokens: 5001 } },
  ];
  for (const change of changes) {
    await assert.rejects(a.prepare(ctx, { ...e.input, ...change }), isCode('conflict'));
    await assert.rejects(b.prepare(ctx, { ...e.input, ...change, operationId: op() }), isCode('conflict'));
  }
  await assert.rejects(a.prepare(ctx, { ...e.input, attemptRef: 'attempt-b' }), isCode('conflict'));
  await assert.rejects(a.prepare(ctx, { ...e.input, invocationRef: 'other-invocation' }), isCode('conflict'));
  const w = await worker(ctx);
  const accepted = await b.claim(ctx, e.result.executionRef!, 'full-range-binding', w, e.admission, reservation());
  assert.ok(accepted.dispatch, 'safe-integer revision must survive PostgreSQL bigint decoding');
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.executions WHERE consumer=$1', [ctx.consumerId]), 1);
  // New fields retain the asynchronous invalid-input contract.
  await assert.rejects(a.prepare(ctx, { ...e.input, operationId: op(),
    limits: { ...e.input.limits, concurrency: 3 } }), isCode('invalid'));
  await assert.rejects(b.claim(ctx, e.result.executionRef!, 'invalid-concurrency', w,
    { ...e.admission, limits: { ...e.input.limits, concurrency: 3 } }, reservation()), isCode('invalid'));
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.requests WHERE consumer=$1 AND id=$2',
    [ctx.consumerId, 'invalid-concurrency']), 0);
  for (const field of ['requestBytes', 'outputBytes', 'tokens'] as const) {
    await assert.rejects(a.prepare(ctx, { ...e.input, operationId: op(), limits: { ...e.input.limits, [field]: 0 } }), isCode('invalid'));
  }
  await assert.rejects(b.prepare(ctx, { ...e.input, attemptRef: 1 } as unknown as ApprovedPreparation), isCode('invalid'));
  await assert.rejects(a.prepare(ctx, { ...e.input, bindingRevision: -1 }), isCode('invalid'));
  await assert.rejects(b.claim(ctx, e.result.executionRef!, 'invalid-limits', w,
    { ...e.admission, limits: { ...e.input.limits, tokens: Infinity } }, reservation()), isCode('invalid'));
});

// Distinct opaque strings cannot alias through integer coercion. Conflicting
// approvals raced on one string must produce one durable sticky winner.
test('opaque attempt identity, conflicting approval race and per-consumer readback', async () => {
  const ctx = context(), account = await connected(ctx), input = await approval(ctx, account.accountRef!);
  const competing = { ...input, operationId: op(), bindingRevision: 1, limits: { ...input.limits, outputBytes: 9000 } };
  const pair = await race(ctx, () => a.prepare(ctx, input), () => b.prepare(ctx, competing));
  assert.equal(pair.filter(r => r.status === 'fulfilled').length, 1);
  const loser = pair.find(r => r.status === 'rejected'); assert.ok(loser && loser.status === 'rejected');
  assert.equal(isCode('conflict')(loser.reason), true);
  const approved = pair[0].status === 'fulfilled' ? input : competing;
  const won = await a.operation(ctx, approved.operationId); assert.ok(won.executionRef);
  assert.equal((await b.prepare(ctx, { ...approved, operationId: op() })).executionRef, won.executionRef);
  assert.equal((await b.execution(ctx, won.executionRef)).accountRef, account.accountRef);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.executions WHERE consumer=$1', [ctx.consumerId]), 1);
  const w = await worker(ctx), envelope = admissionFor(approved, won, account.accountRef!);
  const claim = await b.claim(ctx, won.executionRef, 'opaque-winner', w, envelope, reservation()); assert.ok(claim.dispatch);
  assert.equal(claim.dispatch.limits.outputBytes, approved.limits.outputBytes);
  await a.effect(ctx, won.executionRef, 'opaque-winner', w, 'effect_unknown');
  assert.equal((await b.claim(ctx, won.executionRef, 'new-id', w, envelope, reservation())).dispatch, undefined);
  assert.equal((await a.prepare(ctx, { ...approved, operationId: op() })).executionRef, won.executionRef);
  const distinct = await Promise.all(['attempt-01','attempt-1'].map(attemptRef =>
    a.prepare(ctx, { ...input, operationId: op(), attemptRef })));
  assert.notEqual(distinct[0].executionRef, distinct[1].executionRef);
  assert.notEqual(distinct[0].executionRef, won.executionRef);
  await assert.rejects(a.operation(ctx, pair[0].status === 'fulfilled' ? competing.operationId : input.operationId), isCode('unknown'));
  const foreign = context(), foreignAccount = await connected(foreign);
  const foreignResult = await b.prepare(foreign, { ...input, permittedAccounts: [foreignAccount.accountRef!], issuerEpoch: await a.issuer(foreign) });
  assert.notEqual(foreignResult.executionRef, won.executionRef);
  await assert.rejects(a.execution(foreign, won.executionRef), isCode('unknown'));
});

// Actual persisted summaries, >100 rows, keyset traversal and owner filtering.
// The cursor is a bound, so foreign/nonexistent cursor existence is undisclosed.
test('account listing is consumer-bound, owner-filtered and bounded in stable UUID order', async () => {
  const ctx = context(), foreign = context();
  await a.issuer(ctx); await a.issuer(foreign);
  await admin.query(`INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state)
    SELECT $1,('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
      CASE WHEN n%2=1 THEN 'owner-one' ELSE 'owner-two' END,'mimo-test','Disposable','staging'
    FROM generate_series(1,105) n`, [ctx.consumerId]);
  const expected = Array.from({ length: 105 }, (_, i) => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'));
  const page = await a.accounts(ctx);
  assert.equal(page.accounts.length, 100); assert.equal(page.nextCursor, expected[99]);
  assert.deepEqual(page.accounts.map(row => row.accountRef), expected.slice(0,100));
  const tail = await b.accounts(ctx, { cursor: page.nextCursor, limit: 100 });
  assert.deepEqual(tail.accounts.map(row => row.accountRef), expected.slice(100)); assert.equal(tail.nextCursor, undefined);
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const filtered = await b.accounts(ctx, { ownerRef: 'owner-one', cursor, limit: 7 });
    assert.ok(filtered.accounts.every(row => row.ownerRef === 'owner-one'));
    seen.push(...filtered.accounts.map(row => row.accountRef)); cursor = filtered.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected.filter((_, i) => i%2 === 0));
  assert.deepEqual(await a.accounts(foreign, { ownerRef: 'owner-one' }), { accounts: [] });
  const foreignOnlyRef = '00000000-0000-4000-8000-00000000005a';
  await admin.query(`INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state)
    VALUES ($1,$2,'owner-one','mimo-test','Foreign','staging')`, [foreign.consumerId, foreignOnlyRef]);
  const foreignCursor = await a.accounts(ctx, { cursor: foreignOnlyRef });
  assert.deepEqual(foreignCursor.accounts.map(row => row.accountRef), expected.slice(59));
  // Both cursors fall between local UUIDs 000059 and 000060. Only one
  // exists in another namespace; its existence must not affect the response.
  assert.deepEqual(await b.accounts(ctx, { cursor: '00000000-0000-4000-8000-00000000005b' }), foreignCursor);
  assert.equal((await b.accounts(foreign)).accounts.length, 1);
  assert.deepEqual(await a.accounts(ctx, { ownerRef: 'nonexistent-owner' }), { accounts: [] });
  assert.deepEqual(Object.keys(page.accounts[0]).sort(), ['accountRef','displayName','epoch','ownerRef','profile','revision','state'].sort());
  for (const limit of [0, 101, 1.5, Infinity]) await assert.rejects(a.accounts(ctx, { limit }), isCode('invalid'));
  await assert.rejects(b.accounts(ctx, { cursor: 'invalid-uuid' }), isCode('invalid'));
});


// Synthetic closure evidence tests only the private durable contract. Actual
// context/body/supervisor closure is independently qualified in B3/D.
async function acknowledgeCleanupPage(ctx: TrustedContext, kernel: PostgresKernel, job: CleanupClaim, w: string) {
  if (job.scope.kind !== 'execution') return;
  for (;;) {
    const page = await kernel.cleanupTransports(ctx, job.cleanupRef, w, job.token);
    if (!page.length) return;
    for (const proof of page) {
      assert.ok(proof.token);
      await kernel.acknowledgeTransportClosed(ctx, w, proof, { cleanupRef: job.cleanupRef, token: job.token });
    }
  }
}
async function occupancy(ctx: TrustedContext, account: string): Promise<number> {
  return count(`SELECT count(*)::integer n FROM ag_kernel.requests r JOIN ag_kernel.executions e
    ON e.consumer=r.consumer AND e.ref=r.execution_ref WHERE r.consumer=$1 AND e.account_ref=$2 AND r.transport_occupied`,
  [ctx.consumerId, account]);
}
async function expire(ctx: TrustedContext, w: string) {
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
    [ctx.consumerId, w]);
}

test('B2 distinct executions contend for one account slot, unrelated accounts and consumers admit', async () => {
  const ctx = context(), account = await connected(ctx), unrelated = await connected(ctx);
  const first = await prepared(ctx, account.accountRef!), second = await prepared(ctx, account.accountRef!);
  const w1 = await worker(ctx), w2 = await worker(ctx);
  const pair = await race(ctx, () => a.claim(ctx, first.result.executionRef!, 'first', w1, first.admission, reservation()),
    () => b.claim(ctx, second.result.executionRef!, 'second', w2, second.admission, reservation()));
  assert.equal(pair.every(r => r.status === 'fulfilled'), true);
  // This fails behaviorally on old production before any new column/API is read.
  assert.equal(pair.filter(r => r.status === 'fulfilled' && r.value.dispatch).length, 1);
  assert.equal(pair.filter(r => r.status === 'fulfilled' && r.value.status.code === 'concurrency_limit').length, 1);
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  const other = await prepared(ctx, unrelated.accountRef!);
  assert.ok((await b.claim(ctx, other.result.executionRef!, 'other-account', w2, other.admission, reservation())).dispatch);
  const foreign = context(), foreignAccount = await connected(foreign), foreignWorker = await worker(foreign);
  const foreignExecution = await prepared(foreign, foreignAccount.accountRef!);
  assert.ok((await b.claim(foreign, foreignExecution.result.executionRef!, 'other-consumer', foreignWorker, foreignExecution.admission, reservation())).dispatch);
});

test('B2 execution keeps its narrower approval while sharing the configured account ceiling', async () => {
  const bounds = { ...defaults, maxConcurrent: 2 };
  const x = new PostgresKernel(poolA, bounds), y = new PostgresKernel(poolB, bounds);
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const first = await prepared(ctx, account.accountRef!, {}, x), second = await prepared(ctx, account.accountRef!, {}, x);
  assert.ok((await x.claim(ctx, first.result.executionRef!, 'one', w, first.admission, reservation())).dispatch);
  assert.equal((await y.claim(ctx, first.result.executionRef!, 'too-wide', w, first.admission, reservation())).status.code, 'concurrency_limit');
  assert.ok((await y.claim(ctx, second.result.executionRef!, 'two', w, second.admission, reservation())).dispatch);
  const third = await prepared(ctx, account.accountRef!, {}, x);
  assert.equal((await x.claim(ctx, third.result.executionRef!, 'account-full', w, third.admission, reservation())).dispatch, undefined);
  assert.equal(await occupancy(ctx, account.accountRef!), 2);
});

test('B2 lost owner retains occupancy; exact late closure frees one without refund, unfence or replay', async () => {
  const ctx = context(), account = await connected(ctx), owner = await worker(ctx), live = await worker(ctx);
  const first = await prepared(ctx, account.accountRef!), second = await prepared(ctx, account.accountRef!);
  const permit = await a.claim(ctx, first.result.executionRef!, 'old', owner, first.admission, reservation()); assert.ok(permit.dispatch);
  await expire(ctx, owner);
  const denied = await b.claim(ctx, second.result.executionRef!, 'held', live, second.admission, reservation());
  assert.equal(denied.dispatch, undefined, 'lost ownership is not local transport closure');
  assert.equal(denied.status.code, 'concurrency_limit');
  const unknown = { requestRef: 'old', effect: 'effect_unknown', code: 'owner_lost' };
  assert.deepEqual(await b.request(ctx, first.result.executionRef!, 'old'), unknown);
  assert.equal((await b.execution(ctx, first.result.executionRef!)).state, 'fenced');
  const proof = permit.dispatch.closure;
  // Independent DB ownership contract: even a future adapter cannot rebind a
  // permanent closure proof. Capture only the PG error code, never vendor bodies.
  const rewrites: [string, string][] = [ ['consumer', ctx.consumerId + '-wrong'],
    ['execution_ref', second.result.executionRef!], ['id', 'rewritten-request'],
    ['worker', live], ['closure_token', randomUUID()] ];
  for (const [column, value] of rewrites) {
    let code: string | undefined;
    try {
      await admin.query(`UPDATE ag_kernel.requests SET ${column}=$4 WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
        [ctx.consumerId, first.result.executionRef, 'old', value]);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') code = error.code;
    }
    assert.equal(code, '23514', column);
  }
  const binding = (await admin.query(`SELECT execution_ref AS "executionRef",id AS "requestRef",worker,closure_token AS token,
    json_build_object('originRef',native_origin_ref,'engineIncarnation',engine_incarnation,
      'requestNonce',request_nonce,'generation',descriptor_generation) AS native
    FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
  [ctx.consumerId, first.result.executionRef, 'old'])).rows[0];
  assert.deepEqual(binding, proof);
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  for (const wrong of [ { ...proof, executionRef: second.result.executionRef! }, { ...proof, requestRef: 'held' },
    { ...proof, worker: live }, { ...proof, token: randomUUID() } ]) {
    await assert.rejects(a.acknowledgeTransportClosed(ctx, owner, wrong), isCode('denied'));
    assert.equal(await occupancy(ctx, account.accountRef!), 1);
  }
  await assert.rejects(a.acknowledgeTransportClosed(ctx, live, proof), isCode('denied'));
  await assert.rejects(a.acknowledgeTransportClosed(context(), owner, proof), isCode('denied'));
  await b.acknowledgeTransportClosed(ctx, owner, proof);
  await a.acknowledgeTransportClosed(ctx, owner, proof);
  let reopenCode: string | undefined;
  try {
    await admin.query(`UPDATE ag_kernel.requests SET transport_occupied=true WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
      [ctx.consumerId, first.result.executionRef, 'old']);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') reopenCode = error.code;
  }
  assert.equal(reopenCode, '23514', 'a confirmed one-request closure is permanent');
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  assert.deepEqual(await b.request(ctx, first.result.executionRef!, 'old'), unknown);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, first.result.executionRef]), 1);
  assert.equal((await b.execution(ctx, first.result.executionRef!)).state, 'fenced');
  const allowance = (await admin.query('SELECT max_requests,max_tokens FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, first.result.executionRef])).rows[0];
  assert.deepEqual(allowance, { max_requests: 4, max_tokens: 5000 });
  assert.equal((await a.prepare(ctx, { ...first.input, operationId: op() })).executionRef, first.result.executionRef);
  assert.equal((await b.claim(ctx, first.result.executionRef!, 'old', live, first.admission, reservation())).dispatch, undefined);
  assert.equal((await b.claim(ctx, first.result.executionRef!, 'fresh-old-attempt', live, first.admission, reservation())).status.code, 'fenced');
  assert.equal((await a.claim(ctx, second.result.executionRef!, 'held', live, second.admission, reservation())).dispatch, undefined);
  const newer = await b.claim(ctx, second.result.executionRef!, 'new', live, second.admission, reservation()); assert.ok(newer.dispatch);
  await a.acknowledgeTransportClosed(ctx, owner, proof);
  assert.equal(await occupancy(ctx, account.accountRef!), 1, 'old exact ack cannot release a newer request');
  assert.equal((await a.claim(ctx, second.result.executionRef!, 'over', live, second.admission, reservation())).dispatch, undefined);
  assert.deepEqual(Object.keys(await b.request(ctx, first.result.executionRef!, 'old')).sort(), ['code','effect','requestRef']);
  // Exact late ack itself must classify ownership if neither maintenance nor a
  // callback has observed expiry; otherwise a fresh ID could escape the fence.
  await expire(ctx, live);
  await b.acknowledgeTransportClosed(ctx, live, newer.dispatch.closure);
  assert.deepEqual(await a.request(ctx, second.result.executionRef!, 'new'),
    { requestRef: 'new', effect: 'effect_unknown', code: 'owner_lost' });
  assert.equal((await a.execution(ctx, second.result.executionRef!)).state, 'fenced');
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  const nextOwner = await worker(ctx);
  assert.equal((await a.claim(ctx, second.result.executionRef!, 'no-late-replay', nextOwner, second.admission, reservation())).dispatch, undefined);
});

test('B2 completed effect and failed callback retain transport until explicit owner closure', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const first = await prepared(ctx, account.accountRef!), second = await prepared(ctx, account.accountRef!);
  const completed = await a.claim(ctx, first.result.executionRef!, 'done', w, first.admission, reservation()); assert.ok(completed.dispatch);
  await a.effect(ctx, first.result.executionRef!, 'done', w, 'response_started');
  await a.effect(ctx, first.result.executionRef!, 'done', w, 'completed');
  assert.equal((await b.claim(ctx, second.result.executionRef!, 'completed-held', w, second.admission, reservation())).dispatch, undefined);
  await expire(ctx, w);
  await a.acknowledgeTransportClosed(ctx, w, completed.dispatch.closure);
  assert.equal((await b.request(ctx, first.result.executionRef!, 'done')).effect, 'completed');
  const fresh = await worker(ctx);
  const later = await b.claim(ctx, first.result.executionRef!, 'later-delivery', fresh, first.admission, reservation()); assert.ok(later.dispatch);
  await a.acknowledgeTransportClosed(ctx, w, completed.dispatch.closure);
  assert.equal((await b.execution(ctx, first.result.executionRef!)).state, 'open');
  assert.equal((await a.claim(ctx, second.result.executionRef!, 'old-proof-held', fresh, second.admission, reservation())).dispatch, undefined,
    'an expired completed-request proof cannot close a newer delivery in the same execution');
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  await b.effect(ctx, first.result.executionRef!, 'later-delivery', fresh, 'response_started');
  await b.effect(ctx, first.result.executionRef!, 'later-delivery', fresh, 'completed');
  await b.acknowledgeTransportClosed(ctx, fresh, later.dispatch.closure);
  const failed = await b.claim(ctx, second.result.executionRef!, 'failed', fresh, second.admission, reservation());
  assert.ok(failed.dispatch);
  await b.effect(ctx, second.result.executionRef!, 'failed', fresh, 'effect_unknown');
  const third = await prepared(ctx, account.accountRef!);
  assert.equal((await a.claim(ctx, third.result.executionRef!, 'failed-held', fresh, third.admission, reservation())).dispatch, undefined);
  await a.acknowledgeTransportClosed(ctx, fresh, failed.dispatch.closure);
  assert.equal((await b.request(ctx, second.result.executionRef!, 'failed')).effect, 'effect_unknown');
  assert.ok((await b.claim(ctx, third.result.executionRef!, 'after-closure', fresh, third.admission, reservation())).dispatch);
});

test('B2 cleanup recovers bounded durable exact proofs; premature and stale cleanup cannot release', async () => {
  const bounds = { ...defaults, maxConcurrent: 2, maintenanceBatch: 1 };
  const x = new PostgresKernel(poolA, bounds);
  const ctx = context(), account = await connected(ctx), owner = await worker(ctx), delegate = await worker(ctx);
  const first = await prepared(ctx, account.accountRef!, { limits: { requests: 4, concurrency: 2,
    requestBytes: 4096, outputBytes: 8192, tokens: 5000 } }, x);
  for (const id of ['body-a','body-b']) assert.ok((await x.claim(ctx, first.result.executionRef!, id, owner, first.admission, reservation())).dispatch);
  await x.close(ctx, op(), first.result.executionRef!);
  await expire(ctx, owner);
  const restarted = new PostgresKernel(poolB, bounds);
  const job = await restarted.claimCleanup(ctx, delegate); assert.ok(job && job.scope.kind === 'execution');
  // First assert old observable cleanup behavior, before reading the new proof
  // shape, so negative qualification cannot pass via a missing-field failure.
  await assert.rejects(x.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true), isCode('conflict'));
  assert.equal(job.scope.transports.length, 1, 'bounded page even when execution has multiple occupied transports');
  assert.equal(job.scope.transports[0].requestRef, 'body-a');
  assert.ok(job.scope.transports[0].token, 'proof survives discarded dispatch permits');
  const authority = { cleanupRef: job.cleanupRef, token: job.token }, proof = job.scope.transports[0];
  await assert.rejects(x.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true), isCode('conflict'));
  assert.equal(await occupancy(ctx, account.accountRef!), 2);
  await assert.rejects(x.cleanupTransports(context(), job.cleanupRef, delegate, job.token), isCode('denied'));
  await assert.rejects(x.cleanupTransports(ctx, job.cleanupRef, owner, job.token), isCode('denied'));
  await assert.rejects(x.acknowledgeTransportClosed(ctx, delegate, { ...proof, token: randomUUID() }, authority), isCode('denied'));
  const unrelated = await connected(ctx), other = await prepared(ctx, unrelated.accountRef!, {}, x);
  const otherPermit = await x.claim(ctx, other.result.executionRef!, 'foreign-scope', delegate, other.admission, reservation()); assert.ok(otherPermit.dispatch);
  await assert.rejects(x.acknowledgeTransportClosed(ctx, delegate, otherPermit.dispatch.closure, authority), isCode('denied'));
  await admin.query("UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",
    [ctx.consumerId, job.cleanupRef]);
  await assert.rejects(x.acknowledgeTransportClosed(ctx, delegate, proof, authority), isCode('denied'));
  const reclaimed = await x.claimCleanup(ctx, delegate); assert.ok(reclaimed && reclaimed.scope.kind === 'execution');
  assert.equal(reclaimed.cleanupRef, job.cleanupRef); assert.notEqual(reclaimed.token, job.token);
  assert.deepEqual(reclaimed.scope.transports, job.scope.transports, 'request proof is permanent; only cleanup CAS rotates');
  await assert.rejects(restarted.acknowledgeTransportClosed(ctx, delegate, proof, authority), isCode('denied'));
  const freshAuthority = { cleanupRef: reclaimed.cleanupRef, token: reclaimed.token };
  await restarted.acknowledgeTransportClosed(ctx, delegate, proof, freshAuthority);
  await restarted.acknowledgeTransportClosed(ctx, delegate, proof, freshAuthority);
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  const second = await prepared(ctx, account.accountRef!, {}, x);
  assert.ok((await x.claim(ctx, second.result.executionRef!, 'newer', delegate, second.admission, reservation())).dispatch);
  await restarted.acknowledgeTransportClosed(ctx, delegate, proof, freshAuthority);
  assert.equal(await occupancy(ctx, account.accountRef!), 2);
  await assert.rejects(x.settleCleanup(ctx, reclaimed.cleanupRef, delegate, reclaimed.token, true), isCode('conflict'));
  const page = await x.cleanupTransports(ctx, reclaimed.cleanupRef, delegate, reclaimed.token);
  assert.equal(page.length, 1); assert.equal(page[0].requestRef, 'body-b');
  await restarted.acknowledgeTransportClosed(ctx, delegate, page[0], freshAuthority);
  assert.deepEqual(await x.cleanupTransports(ctx, reclaimed.cleanupRef, delegate, reclaimed.token), []);
  await x.settleCleanup(ctx, reclaimed.cleanupRef, delegate, reclaimed.token, true);
  await restarted.settleCleanup(ctx, reclaimed.cleanupRef, delegate, reclaimed.token, true);
  await restarted.acknowledgeTransportClosed(ctx, delegate, page[0], freshAuthority);
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  for (const id of ['body-a','body-b']) assert.equal((await x.request(ctx, first.result.executionRef!, id)).effect, 'effect_unknown');
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, first.result.executionRef]), 2);
});

test('B2 old generation, credential cleanup and restore keep occupied account capacity', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const old = await prepared(ctx, account.accountRef!);
  const permit = await a.claim(ctx, old.result.executionRef!, 'old-generation', w, old.admission, reservation()); assert.ok(permit.dispatch);
  const reconnect = await a.beginAccount(ctx, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: account.accountRef, expectedRevision: account.revision });
  const candidate = await a.startCandidate(ctx, reconnect.operationRef, w); assert.ok(candidate);
  await a.acknowledgeCandidate(ctx, reconnect.operationRef, w,
    { generation: candidate.candidate, nativePhysicalIdentity: randomUUID(), profile: candidate.profile });
  const newer = await prepared(ctx, account.accountRef!);
  assert.equal((await b.claim(ctx, newer.result.executionRef!, 'new-generation-held', w, newer.admission, reservation())).dispatch, undefined);
  // Claim both preexisting cleanup jobs without releasing the execution transport.
  const jobs = [await a.claimCleanup(ctx, w), await b.claimCleanup(ctx, w)];
  const generation = jobs.find(j => j?.scope.kind === 'generation'); assert.ok(generation);
  await assert.rejects(b.settleCleanup(ctx, generation.cleanupRef, w, generation.token, true), isCode('conflict'));
  assert.equal((await a.claim(ctx, newer.result.executionRef!, 'erasure-held', w, newer.admission, reservation())).dispatch, undefined);
  await a.restore(ctx, await a.issuer(ctx), randomUUID());
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  assert.deepEqual(await b.request(ctx, old.result.executionRef!, 'old-generation'),
    { requestRef: 'old-generation', effect: 'effect_unknown', code: 'restore' });
  const quarantined = await a.account(ctx, account.accountRef!);
  const recovered = await a.beginAccount(ctx, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: account.accountRef, expectedRevision: quarantined.revision });
  const recovery = await a.startCandidate(ctx, recovered.operationRef, w); assert.ok(recovery);
  await a.acknowledgeCandidate(ctx, recovered.operationRef, w,
    { generation: recovery.candidate, nativePhysicalIdentity: randomUUID(), profile: recovery.profile });
  const current = await prepared(ctx, account.accountRef!);
  assert.equal((await b.claim(ctx, current.result.executionRef!, 'restore-held', w, current.admission, reservation())).dispatch, undefined);
  await assert.rejects(b.settleCleanup(ctx, generation.cleanupRef, w, generation.token, true), isCode('conflict'));
  await a.acknowledgeTransportClosed(ctx, w, permit.dispatch.closure);
  await b.settleCleanup(ctx, generation.cleanupRef, w, generation.token, true);
  assert.deepEqual(await b.request(ctx, old.result.executionRef!, 'old-generation'),
    { requestRef: 'old-generation', effect: 'effect_unknown', code: 'restore' });
  assert.ok((await b.claim(ctx, current.result.executionRef!, 'restored-after-closure', w, current.admission, reservation())).dispatch);
});

test('B2 closure and cleanup authority capture whitelisted primitives before consumer lock await', async () => {
  const bounds = { ...defaults, maxConcurrent: 2 };
  const x = new PostgresKernel(poolA, bounds);
  const ctx = context(), account = await connected(ctx), owner = await worker(ctx), delegate = await worker(ctx);
  const first = await prepared(ctx, account.accountRef!, {}, x), second = await prepared(ctx, account.accountRef!, {}, x);
  const one = await x.claim(ctx, first.result.executionRef!, 'A', owner, first.admission, reservation()); assert.ok(one.dispatch);
  const two = await x.claim(ctx, second.result.executionRef!, 'B', owner, second.admission, reservation()); assert.ok(two.dispatch);
  const third = await prepared(ctx, account.accountRef!, {}, x);
  assert.equal((await x.claim(ctx, third.result.executionRef!, 'capacity-held', delegate, third.admission, reservation())).dispatch, undefined,
    'behavior regression must fail on old production before any new closure API');
  const mutable: TransportClosure = { ...one.dispatch.closure };
  await mutateAtConsumerLock(ctx, () => x.acknowledgeTransportClosed(ctx, owner, mutable),
    () => Object.assign(mutable, two.dispatch!.closure));
  const held = (await admin.query(`SELECT execution_ref,id FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied`, [ctx.consumerId])).rows;
  assert.deepEqual(held, [{ execution_ref: second.result.executionRef, id: 'B' }]);
  await x.close(ctx, op(), second.result.executionRef!);
  const job = await x.claimCleanup(ctx, delegate); assert.ok(job && job.scope.kind === 'execution');
  const cleanup = { cleanupRef: job.cleanupRef, token: job.token }, original = { ...cleanup };
  await mutateAtConsumerLock(ctx, () => x.acknowledgeTransportClosed(ctx, delegate, two.dispatch!.closure, cleanup),
    () => { cleanup.cleanupRef = randomUUID(); cleanup.token = randomUUID(); });
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  await x.settleCleanup(ctx, original.cleanupRef, delegate, original.token, true);
});

test('B2 accepted insert omitting occupancy conservatively holds the account slot', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const first = await prepared(ctx, account.accountRef!), second = await prepared(ctx, account.accountRef!);
  await admin.query(`INSERT INTO ag_kernel.requests(consumer,execution_ref,id,effect,worker)
    VALUES ($1,$2,'accepted-without-new-fields','dispatch_started',$3)`,
  [ctx.consumerId, first.result.executionRef, w]);
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  const denied = await b.claim(ctx, second.result.executionRef!, 'must-stay-held', w, second.admission, reservation());
  assert.equal(denied.dispatch, undefined);
  assert.deepEqual(denied.status, { requestRef: 'must-stay-held', effect: 'not_dispatched', code: 'concurrency_limit' });
  const row = (await admin.query(`SELECT closure_token FROM ag_kernel.requests
    WHERE consumer=$1 AND execution_ref=$2 AND id='accepted-without-new-fields'`,
  [ctx.consumerId, first.result.executionRef])).rows[0];
  assert.equal(row.closure_token, null, 'conservative default does not fabricate closure authority');
});

test('B2 numbered upgrade retains legacy active, completed and unknown occupancy without fabricating closure authority', async () => {
  const active = (await admin.query(`SELECT id,effect FROM ag_kernel.requests
    WHERE consumer=$1 AND execution_ref=$2 AND id IN ('legacy-dispatch','legacy-response') ORDER BY id`,
  [legacy.ctx.consumerId, legacy.execution])).rows;
  assert.deepEqual(active, [
    { id: 'legacy-dispatch', effect: 'dispatch_started' },
    { id: 'legacy-response', effect: 'response_started' },
  ], 'numbered upgrade preserves preexisting active effects before loss classification');
  const w = await worker(legacy.ctx), fresh = await prepared(legacy.ctx, legacy.account);
  assert.equal((await b.claim(legacy.ctx, fresh.result.executionRef!, 'legacy-held', w, fresh.admission, reservation())).dispatch, undefined);
  assert.equal(await occupancy(legacy.ctx, legacy.account), 4);
  const rows = (await admin.query(`SELECT id,effect,transport_occupied,closure_token FROM ag_kernel.requests
    WHERE consumer=$1 AND execution_ref=$2 ORDER BY id`, [legacy.ctx.consumerId, legacy.execution])).rows;
  assert.deepEqual(rows, [
    { id: 'legacy-completed', effect: 'completed', transport_occupied: true, closure_token: null },
    { id: 'legacy-denied', effect: 'not_dispatched', transport_occupied: false, closure_token: null },
    { id: 'legacy-dispatch', effect: 'effect_unknown', transport_occupied: true, closure_token: null },
    { id: 'legacy-response', effect: 'effect_unknown', transport_occupied: true, closure_token: null },
    { id: 'legacy-unknown', effect: 'effect_unknown', transport_occupied: true, closure_token: null },
  ]);
  await a.close(legacy.ctx, op(), legacy.execution);
  const job = await b.claimCleanup(legacy.ctx, w); assert.ok(job && job.scope.kind === 'execution');
  assert.equal(job.scope.transports.length, 4);
  for (const proof of job.scope.transports) {
    assert.equal(proof.token, undefined);
    await assert.rejects(a.acknowledgeTransportClosed(legacy.ctx, w, proof, { cleanupRef: job.cleanupRef, token: job.token }), isCode('invalid'));
  }
  await assert.rejects(a.settleCleanup(legacy.ctx, job.cleanupRef, w, job.token, true), isCode('conflict'));
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [legacy.ctx.consumerId, legacy.execution]), 4);
});


// Regression: non-entry must spend a permanent request/cap while holding the
// account slot; only exact separate closure permits the next bounded request.
test('B2a exact positive rejection retains occupancy and spent budget until closure', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const limits = { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 };
  const e = await prepared(ctx, account.accountRef!, { limits });
  const native = reservation();
  const first = await a.claim(ctx, e.result.executionRef!, 'first', w, e.admission, native);
  assert.ok(first.dispatch);
  assert.deepEqual(first.dispatch.closure.native, { ...native, generation: first.dispatch.descriptor.generation });
  const rejected = await a.rejectBeforeDispatch(ctx, w, first.dispatch.closure, false);
  assert.deepEqual(rejected, { requestRef: 'first', effect: 'rejected_before_dispatch', code: 'native_rejected' });
  assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'first'), rejected);
  assert.equal((await b.execution(ctx, e.result.executionRef!)).state, 'open');
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  const blocked = await b.claim(ctx, e.result.executionRef!, 'held', w, e.admission, reservation());
  assert.deepEqual(blocked, { status: { requestRef: 'held', effect: 'not_dispatched', code: 'concurrency_limit' } });
  const budget = async () => (await admin.query(
    'SELECT request_count,max_requests,max_tokens,deadline,state FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef])).rows[0];
  assert.equal((await budget()).request_count, 1);
  await a.acknowledgeTransportClosed(ctx, w, first.dispatch.closure);
  assert.deepEqual(await b.rejectBeforeDispatch(ctx, w, first.dispatch.closure, false), rejected);
  const second = await b.claim(ctx, e.result.executionRef!, 'second', w, e.admission, reservation());
  assert.ok(second.dispatch);
  assert.deepEqual(second.dispatch.limits, limits);
  assert.equal(second.dispatch.deadline, e.admission.expiresAt);
  await b.rejectBeforeDispatch(ctx, w, second.dispatch.closure, false);
  await a.acknowledgeTransportClosed(ctx, w, second.dispatch.closure);
  assert.deepEqual(await budget(), { request_count: 2, max_requests: 2, max_tokens: 5000,
    deadline: new Date(e.admission.expiresAt), state: 'open' });
  assert.deepEqual(await a.claim(ctx, e.result.executionRef!, 'spent', w, e.admission, reservation()),
    { status: { requestRef: 'spent', effect: 'not_dispatched', code: 'limit' } });
  assert.equal((await budget()).request_count, 2);
});

// Regression: a wrong native tuple, worker or closure token must neither reject
// nor release a request; generic effect and entered:true cannot bypass evidence.
test('B2a rejection and closure require exact native dispatch identity', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!);
  const claim = await a.claim(ctx, e.result.executionRef!, 'exact', w, e.admission, reservation());
  assert.ok(claim.dispatch);
  const proof = claim.dispatch.closure;
  const wrong: NativeDispatchProof[] = [
    { ...proof, native: { ...proof.native, originRef: 'other-origin' } },
    { ...proof, native: { ...proof.native, engineIncarnation: randomUUID() } },
    { ...proof, native: { ...proof.native, requestNonce: randomUUID() } },
    { ...proof, native: { ...proof.native, generation: randomUUID() } },
    { ...proof, token: randomUUID() }, { ...proof, worker: randomUUID() },
  ];
  for (const invalid of wrong) {
    await assert.rejects(b.rejectBeforeDispatch(ctx, w, invalid, false), isCode('denied'));
    await assert.rejects(b.acknowledgeTransportClosed(ctx, w, invalid), isCode('denied'));
  }
  await assert.rejects(b.rejectBeforeDispatch(ctx, randomUUID(), proof, false), isCode('denied'));
  await assert.rejects(b.rejectBeforeDispatch({ consumerId: 'other-consumer' }, w, proof, false), isCode('unknown'));
  await assert.rejects(b.rejectBeforeDispatch(ctx, w, { ...proof, requestRef: 'other-request' }, false), isCode('unknown'));
  await assert.rejects(b.rejectBeforeDispatch(ctx, w, { ...proof, executionRef: randomUUID() }, false), isCode('unknown'));
  await assert.rejects(b.rejectBeforeDispatch(ctx, w, proof, true as false), isCode('invalid'));
  await assert.rejects(b.effect(ctx, e.result.executionRef!, 'exact', w, 'rejected_before_dispatch' as never), isCode('invalid'));
  await assert.rejects(b.claim(ctx, e.result.executionRef!, 'missing-authority', w, e.admission,
    undefined as unknown as NativeReservation), isCode('invalid'));
  assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'exact'), { requestRef: 'exact', effect: 'dispatch_started' });
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 1);
  assert.equal((await a.rejectBeforeDispatch(ctx, w, proof, false)).effect, 'rejected_before_dispatch');
});

// Regression: duplicate callbacks with either original or substituted
// reservations must never obtain another dispatch permit or rearm rejection.
test('B2a duplicate claim races and terminal readback never grant another permit', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!), native = reservation();
  const pair = await race(ctx,
    () => a.claim(ctx, e.result.executionRef!, 'duplicate', w, e.admission, native),
    () => b.claim(ctx, e.result.executionRef!, 'duplicate', w, e.admission, reservation()));
  const claims = pair.map(value => { assert.equal(value.status, 'fulfilled'); return (value as PromiseFulfilledResult<Awaited<ReturnType<PostgresKernel['claim']>>>).value; });
  assert.equal(claims.filter(value => value.dispatch).length, 1);
  const accepted = claims.find(value => value.dispatch)!;
  assert.ok(accepted.dispatch);
  const first = await a.rejectBeforeDispatch(ctx, w, accepted.dispatch.closure, false);
  const restarted = new PostgresKernel(poolB);
  assert.deepEqual(await restarted.rejectBeforeDispatch(ctx, w, accepted.dispatch.closure, false), first);
  for (const input of [native, reservation()]) {
    assert.deepEqual(await restarted.claim(ctx, e.result.executionRef!, 'duplicate', w, e.admission, input), { status: first });
  }
  await a.acknowledgeTransportClosed(ctx, w, accepted.dispatch.closure);
  assert.deepEqual(await restarted.claim(ctx, e.result.executionRef!, 'duplicate', w, e.admission, reservation()), { status: first });
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2", [ctx.consumerId, w]);
  assert.deepEqual(await restarted.rejectBeforeDispatch(ctx, w, accepted.dispatch.closure, false), first);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 1);
});

// Regression: a late positive non-entry report must never turn response,
// completion or unknown into rejection, even when it has the original proof.
test('B2a post-response completed and unknown settlements are denied', async () => {
  for (const terminal of ['response_started', 'completed', 'effect_unknown'] as const) {
    const ctx = context(), account = await connected(ctx), w = await worker(ctx);
    const e = await prepared(ctx, account.accountRef!);
    const claim = await a.claim(ctx, e.result.executionRef!, 'already-entered', w, e.admission, reservation());
    assert.ok(claim.dispatch);
    if (terminal === 'completed') await a.effect(ctx, e.result.executionRef!, 'already-entered', w, 'response_started');
    await a.effect(ctx, e.result.executionRef!, 'already-entered', w, terminal);
    await assert.rejects(b.rejectBeforeDispatch(ctx, w, claim.dispatch.closure, false), isCode('conflict'));
    assert.equal((await b.request(ctx, e.result.executionRef!, 'already-entered')).effect, terminal);
    assert.equal(await occupancy(ctx, account.accountRef!), 1);
    await a.acknowledgeTransportClosed(ctx, w, claim.dispatch.closure);
    assert.equal((await b.request(ctx, e.result.executionRef!, 'already-entered')).effect, terminal);
  }
});

// Regression: throwing on lost lease would roll back unknown/fence and let a
// late entered:false rehabilitate an ambiguous dispatch after closure.
test('B2a expired original lease commits unknown and keeps the execution fenced', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!);
  const claim = await a.claim(ctx, e.result.executionRef!, 'lease-lost', w, e.admission, reservation());
  assert.ok(claim.dispatch);
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
    [ctx.consumerId, w]);
  const unknown = await b.rejectBeforeDispatch(ctx, w, claim.dispatch.closure, false);
  assert.deepEqual(unknown, { requestRef: 'lease-lost', effect: 'effect_unknown', code: 'owner_lost' });
  assert.deepEqual(await a.request(ctx, e.result.executionRef!, 'lease-lost'), unknown);
  assert.equal((await a.execution(ctx, e.result.executionRef!)).state, 'fenced');
  await assert.rejects(a.rejectBeforeDispatch(ctx, w, claim.dispatch.closure, false), isCode('conflict'));
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  const fresh = await worker(ctx);
  assert.equal((await a.claim(ctx, e.result.executionRef!, 'still-held', fresh, e.admission, reservation())).dispatch, undefined);
  await b.acknowledgeTransportClosed(ctx, w, claim.dispatch.closure);
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  assert.deepEqual(await a.claim(ctx, e.result.executionRef!, 'after-closure', fresh, e.admission, reservation()),
    { status: { requestRef: 'after-closure', effect: 'not_dispatched', code: 'fenced' } });
  assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'lease-lost'), unknown);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 1);
});

// Regression: missing native settlement is ambiguity, not proof of non-entry;
// reconciliation must preserve unknown despite a late positive callback.
test('B2a lost rejection settlement remains unknown after reconciliation and closure', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!);
  const claim = await a.claim(ctx, e.result.executionRef!, 'settlement-lost', w, e.admission, reservation());
  assert.ok(claim.dispatch);
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
    [ctx.consumerId, w]);
  await b.reconcile(ctx);
  await assert.rejects(b.rejectBeforeDispatch(ctx, w, claim.dispatch.closure, false), isCode('conflict'));
  assert.equal((await a.request(ctx, e.result.executionRef!, 'settlement-lost')).effect, 'effect_unknown');
  assert.equal((await a.execution(ctx, e.result.executionRef!)).state, 'fenced');
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
  await b.acknowledgeTransportClosed(ctx, w, claim.dispatch.closure);
  assert.equal((await a.request(ctx, e.result.executionRef!, 'settlement-lost')).effect, 'effect_unknown');
  assert.equal((await a.execution(ctx, e.result.executionRef!)).state, 'fenced');
});

// Regression: mutable callback/proof objects must not change authority across
// an actual DB consumer-row lock wait; only captured primitive fields are bound.
test('B2a reservation and non-entry proof capture before actual transaction await', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!);
  const mutable = { ...reservation(), ignored: { diagnostic: 'discarded-fixture' } }, original = { ...mutable };
  const generation = (await admin.query('SELECT generation FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef])).rows[0].generation as string;
  const claim = await mutateAtConsumerLock(ctx,
    () => a.claim(ctx, e.result.executionRef!, 'mutation', w, e.admission, mutable),
    () => Object.assign(mutable, reservation()));
  assert.ok(claim.dispatch);
  const expected = { originRef: original.originRef, engineIncarnation: original.engineIncarnation,
    requestNonce: original.requestNonce, generation };
  assert.deepEqual(claim.dispatch.closure.native, expected);
  const stored = (await admin.query('SELECT native_origin_ref,engine_incarnation,request_nonce,descriptor_generation FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
    [ctx.consumerId, e.result.executionRef, 'mutation'])).rows[0];
  assert.deepEqual(stored, { native_origin_ref: expected.originRef, engine_incarnation: expected.engineIncarnation,
    request_nonce: expected.requestNonce, descriptor_generation: generation });
  const proof: NativeDispatchProof = { ...claim.dispatch.closure, native: { ...claim.dispatch.closure.native } };
  const result = await mutateAtConsumerLock(ctx, () => a.rejectBeforeDispatch(ctx, w, proof, false),
    () => { proof.token = randomUUID(); Object.assign(proof.native, reservation(), { generation: randomUUID() }); });
  assert.equal(result.effect, 'rejected_before_dispatch');
  assert.deepEqual(await b.request(ctx, e.result.executionRef!, 'mutation'), result);
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
});

// Regression: storage must prevent rebinding/NULL upgrade authority, and
// trusted cleanup must recover exact original native identity without a permit.
test('B2a immutable stored binding survives cleanup restart and restore', async () => {
  const ctx = context(), account = await connected(ctx), owner = await worker(ctx), delegate = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!);
  const claim = await a.claim(ctx, e.result.executionRef!, 'cleanup-native', owner, e.admission, reservation());
  assert.ok(claim.dispatch);
  for (const [column, value] of [
    ['native_origin_ref', 'replacement-origin'], ['engine_incarnation', randomUUID()],
    ['request_nonce', randomUUID()], ['descriptor_generation', randomUUID()],
  ]) {
    let code: string | undefined;
    try { await admin.query(`UPDATE ag_kernel.requests SET ${column}=$4 WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
      [ctx.consumerId, e.result.executionRef, 'cleanup-native', value]); }
    catch (error) { code = (error as { code?: string }).code; }
    assert.equal(code, '23514', 'database must refuse immutable native rebinding');
  }
  const rejected = await a.rejectBeforeDispatch(ctx, owner, claim.dispatch.closure, false);
  await a.close(ctx, op(), e.result.executionRef!);
  const restarted = new PostgresKernel(poolB);
  const job = await restarted.claimCleanup(ctx, delegate); assert.ok(job && job.scope.kind === 'execution');
  assert.deepEqual(job.scope.transports, [claim.dispatch.closure]);
  assert.deepEqual(await restarted.cleanupTransports(ctx, job.cleanupRef, delegate, job.token), [claim.dispatch.closure]);
  const authority = { cleanupRef: job.cleanupRef, token: job.token };
  const wrong = { ...claim.dispatch.closure, native: { ...claim.dispatch.closure.native, requestNonce: randomUUID() } };
  await assert.rejects(a.acknowledgeTransportClosed(ctx, delegate, wrong, authority), isCode('denied'));
  await assert.rejects(restarted.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true), isCode('conflict'));
  await a.acknowledgeTransportClosed(ctx, delegate, job.scope.transports[0], authority);
  await restarted.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true);
  await a.restore(ctx, await a.issuer(ctx), randomUUID());
  assert.deepEqual(await restarted.request(ctx, e.result.executionRef!, 'cleanup-native'), rejected);
  const row = (await admin.query('SELECT native_origin_ref,engine_incarnation,request_nonce,descriptor_generation,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
    [ctx.consumerId, e.result.executionRef, 'cleanup-native'])).rows[0];
  assert.deepEqual(row, { native_origin_ref: claim.dispatch.closure.native.originRef,
    engine_incarnation: claim.dispatch.closure.native.engineIncarnation, request_nonce: claim.dispatch.closure.native.requestNonce,
    descriptor_generation: claim.dispatch.closure.native.generation, transport_occupied: false });
  let code: string | undefined;
  try { await admin.query("UPDATE ag_kernel.requests SET effect='dispatch_started' WHERE consumer=$1 AND execution_ref=$2 AND id=$3",
    [ctx.consumerId, e.result.executionRef, 'cleanup-native']); }
  catch (error) { code = (error as { code?: string }).code; }
  assert.equal(code, '23514', 'a positive rejection is a permanent terminal fact');
});

// Regression: an accepted SQL002 row with a token but NULL native binding must
// not acquire proof authority or free capacity during003, cleanup or restore.
test('B2a SQL003 legacy NULL native binding conservatively retains occupancy', async () => {
  const ctx = nativeLegacy.ctx, fresh = await worker(ctx);
  const fields = async () => (await admin.query('SELECT effect,closure_token,native_origin_ref,engine_incarnation,request_nonce,descriptor_generation,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
    [ctx.consumerId, nativeLegacy.execution, 'pre003'])).rows[0];
  const expected = { effect: 'completed', closure_token: nativeLegacy.token, native_origin_ref: null,
    engine_incarnation: null, request_nonce: null, descriptor_generation: null, transport_occupied: true };
  assert.deepEqual(await fields(), expected);
  const e = await prepared(ctx, nativeLegacy.account);
  assert.equal((await b.claim(ctx, e.result.executionRef!, 'legacy-held', fresh, e.admission, reservation())).dispatch, undefined);
  const fabricated: NativeDispatchProof = { executionRef: nativeLegacy.execution, requestRef: 'pre003',
    worker: nativeLegacy.worker, token: nativeLegacy.token,
    native: { ...reservation(), generation: nativeLegacy.generation } };
  await assert.rejects(a.rejectBeforeDispatch(ctx, nativeLegacy.worker, fabricated, false), isCode('denied'));
  await assert.rejects(a.acknowledgeTransportClosed(ctx, nativeLegacy.worker, fabricated), isCode('denied'));
  let code: string | undefined;
  try { await admin.query(`UPDATE ag_kernel.requests SET native_origin_ref='invented',engine_incarnation=$3,
      request_nonce=$4,descriptor_generation=$5 WHERE consumer=$1 AND execution_ref=$2 AND id='pre003'`,
    [ctx.consumerId, nativeLegacy.execution, randomUUID(), randomUUID(), nativeLegacy.generation]); }
  catch (error) { code = (error as { code?: string }).code; }
  assert.equal(code, '23514');
  await a.close(ctx, op(), nativeLegacy.execution);
  const job = await b.claimCleanup(ctx, fresh); assert.ok(job && job.scope.kind === 'execution');
  assert.deepEqual(job.scope.transports, [{ executionRef: nativeLegacy.execution, requestRef: 'pre003',
    worker: nativeLegacy.worker, token: nativeLegacy.token }]);
  await assert.rejects(a.acknowledgeTransportClosed(ctx, fresh, job.scope.transports[0],
    { cleanupRef: job.cleanupRef, token: job.token }), isCode('invalid'));
  await assert.rejects(b.settleCleanup(ctx, job.cleanupRef, fresh, job.token, true), isCode('conflict'));
  await a.restore(ctx, await a.issuer(ctx), randomUUID());
  assert.deepEqual(await fields(), expected);
  assert.equal(await occupancy(ctx, nativeLegacy.account), 1);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, nativeLegacy.execution]), 1);
});

// Red on005 when all historical worker/issuer slots are consumed: both fresh
// recovery identities deny, stranding cleanup and fresh-epoch restore at capacity.
test('D-final populated SQL003/004 upgrade prepays fresh recovery authority at fact saturation', async () => {
  const h = recoveryHistory, ctx = h.ctx;
  const used = await count('SELECT fact_used AS n FROM ag_kernel.consumers WHERE consumer=$1', [ctx.consumerId]);
  const accountUsed = await count('SELECT fact_used AS n FROM ag_kernel.accounts WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, h.account]);
  const kernel = new PostgresKernel(poolA, defaults,
    { ...factDefaults, maxConsumerFacts: used, maxAccountFacts: accountUsed });
  const budget = async () => count('SELECT used AS n FROM ag_kernel.fact_budget', []);
  const serviceUsed = await budget();
  assert.equal(serviceUsed, await count('SELECT 1+sum(fact_used) AS n FROM ag_kernel.consumers', []));
  const proof: NativeDispatchProof = { executionRef: h.execution, requestRef: 'history-unknown',
    worker: h.workers[0], token: h.token, native: { originRef: 'sandbox-native-origin',
      engineIncarnation: h.incarnation, requestNonce: h.nonce, generation: h.generation } };
  const saved = await kernel.savedExecution(ctx, h.execution);
  assert.deepEqual(await kernel.requestProof(ctx, h.execution, 'history-unknown'), proof);
  await assert.rejects(kernel.prepare(ctx, await approval(ctx, h.account)), isCode('denied'));
  await assert.rejects(kernel.beginAccount(ctx, { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'workspace-fixture', profile: 'mimo-test', displayName: 'Denied at capacity' }), isCode('denied'));
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.operations WHERE consumer=$1', [ctx.consumerId]), 1);
  await assert.rejects(kernel.heartbeat(ctx, h.workers[0]), isCode('denied'));
  await assert.rejects(kernel.claimCleanup(ctx, h.workers[0]), isCode('denied'));
  const closeId = op(), closed = await kernel.close(ctx, closeId, h.execution);
  assert.equal(closed.state, 'applied');

  const freshWorker = randomUUID(), freshIssuer = randomUUID();
  const recovery = await Promise.allSettled([
    kernel.heartbeat(ctx, freshWorker), kernel.restore(ctx, h.issuers[0], freshIssuer),
  ]);
  assert.deepEqual(recovery.map(result => result.status === 'fulfilled' ? 'fulfilled'
    : result.reason instanceof KernelError ? result.reason.code : 'unexpected failure'),
  ['fulfilled', 'fulfilled'], 'fresh worker and issuer must use prepaid migration headroom');
  assert.equal(await kernel.issuer(ctx), freshIssuer);
  assert.equal((await kernel.account(ctx, h.account)).state, 'quarantined');
  const restored = await kernel.savedExecution(ctx, h.execution);
  assert.deepEqual(restored.admission, saved.admission);
  assert.equal(restored.state, 'fenced'); assert.equal(restored.dispatchAllowed, false);
  assert.deepEqual(await kernel.close(ctx, closeId, h.execution), closed);
  await assert.rejects(kernel.restore(ctx, freshIssuer, h.issuers[0]), isCode('conflict'));

  // Restore also queues generation cleanup; acquire the expired execution lease
  // through the public kernel without assuming ordering of the two UUIDs.
  let executionJob: CleanupClaim | undefined;
  for (let n = 0; n < 2; n++) {
    const job = await kernel.claimCleanup(ctx, freshWorker); assert.ok(job);
    if (job.scope.kind === 'execution') { executionJob = job; break; }
  }
  assert.ok(executionJob?.scope.kind === 'execution');
  assert.equal(executionJob.scope.executionRef, h.execution);
  assert.deepEqual(executionJob.scope.transports, [proof]);
  await assert.rejects(kernel.settleCleanup(ctx, executionJob.cleanupRef, freshWorker, executionJob.token, true), isCode('conflict'));
  await kernel.acknowledgeTransportClosed(ctx, freshWorker, proof,
    { cleanupRef: executionJob.cleanupRef, token: executionJob.token });
  await kernel.settleCleanup(ctx, executionJob.cleanupRef, freshWorker, executionJob.token, true);
  assert.equal(await occupancy(ctx, h.account), 0);
  assert.equal((await kernel.request(ctx, h.execution, 'history-unknown')).effect, 'effect_unknown');
  assert.deepEqual(await kernel.requestProof(ctx, h.execution, 'history-unknown'), proof);
  const nextWorker = await worker(ctx, kernel);
  await assert.rejects(kernel.restore(ctx, freshIssuer, randomUUID()), isCode('denied'));
  const workers = (await admin.query('SELECT worker FROM ag_kernel.workers WHERE consumer=$1', [ctx.consumerId])).rows;
  assert.deepEqual(workers.map(row => row.worker).sort(), [h.workers[0], freshWorker, nextWorker].sort());
  const issuers = (await admin.query('SELECT issuer FROM ag_kernel.issuer_epochs WHERE consumer=$1', [ctx.consumerId])).rows;
  assert.deepEqual(issuers.map(row => row.issuer).sort(), [...h.issuers, freshIssuer].sort());
  assert.equal(accountUsed, 12); // Account, candidate, execution, operation and request prepayments.
  assert.equal(used, 1 + 17 + 33 + accountUsed + 2); // Prepaid recovery slots remain charged after orphan reclaim.
  assert.equal(await count('SELECT fact_used AS n FROM ag_kernel.consumers WHERE consumer=$1', [ctx.consumerId]), used);
  assert.equal(await count('SELECT fact_used AS n FROM ag_kernel.accounts WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, h.account]), accountUsed);
  assert.equal(await budget(), serviceUsed, 'recovery and exact cleanup neither charge again nor refund facts');
});

// Red when expired enrollment permanently exhausts prepaid worker slots, or
// reclaim forgets any reference, revives this expired UUID or refunds facts.
test('D-final heartbeat reclaims only expired orphan workers across repeated finite-slot reuse', async () => {
  const ctx = context(), foreign = context();
  const facts = { ...factDefaults, workerSlots: 8, issuerSlots: 4 };
  const kernel = new PostgresKernel(poolA, { ...defaults, workerLeaseMs: 300_000 }, facts);
  await kernel.issuer(ctx);
  const account = await connected(ctx, kernel);
  const candidateWorker = (await admin.query(`SELECT worker FROM ag_kernel.candidates
    WHERE consumer=$1 AND account_ref=$2`, [ctx.consumerId, account.accountRef])).rows[0].worker as string;
  const requestWorker = await worker(ctx, kernel), cleanupWorker = await worker(ctx, kernel);
  const journalWorker = await worker(ctx, kernel), live = await worker(ctx, kernel);
  const incoming = await worker(ctx, kernel), orphans = [await worker(ctx, kernel), await worker(ctx, kernel)];
  const execution = await prepared(ctx, account.accountRef!, {}, kernel);
  const claimed = await kernel.claim(ctx, execution.result.executionRef!, 'held-unknown', requestWorker,
    execution.admission, reservation());
  assert.ok(claimed.dispatch);
  await kernel.effect(ctx, execution.result.executionRef!, 'held-unknown', requestWorker, 'effect_unknown');

  const pending = await staged(ctx, {}, kernel), permit = await kernel.startCandidate(ctx, pending.operationRef, journalWorker);
  assert.ok(permit);
  await admin.query(`INSERT INTO ag_management.candidate_journal(consumer,operation_id,account_ref,
    owner_ref,purpose,generation,worker,profile,base_url,model,qualification_ref)
    VALUES ($1,$2,$3,'workspace-fixture','create',$4,$5,'mimo-test','https://native.invalid','mimo-test','sandbox-worker-reclaim')`,
  [ctx.consumerId, pending.operationRef, pending.accountRef, permit.candidate, journalWorker]);
  await kernel.unknownCandidate(ctx, pending.operationRef, journalWorker);
  // Legal terminal fixtures isolate the independent journal and cleanup FKs;
  // the journal's immutable worker remains after the candidate owner is absent.
  await admin.query('UPDATE ag_kernel.candidates SET worker=NULL WHERE consumer=$1 AND generation=$2',
    [ctx.consumerId, permit.candidate]);
  await admin.query(`UPDATE ag_kernel.cleanup SET state='done',worker=$3,token=$4
    WHERE consumer=$1 AND generation=$2`, [ctx.consumerId, permit.candidate, cleanupWorker, randomUUID()]);
  await kernel.heartbeat(foreign, incoming);
  const referenced = [candidateWorker, requestWorker, cleanupWorker, journalWorker];
  await admin.query(`UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second'
    WHERE (consumer=$1 AND worker=ANY($2::uuid[])) OR (consumer=$3 AND worker=$4)`,
  [ctx.consumerId, [...referenced, incoming, ...orphans], foreign.consumerId, incoming]);

  const rows = async () => Promise.all([
    ['ag_kernel.accounts', 'ref'], ['ag_kernel.operations', 'id'], ['ag_kernel.candidates', 'generation'],
    ['ag_kernel.executions', 'ref'], ['ag_kernel.requests', 'execution_ref,id'],
    ['ag_kernel.cleanup', 'ref'], ['ag_management.candidate_journal', 'generation'],
  ].map(async ([table, order]) => (await admin.query(`SELECT * FROM ${table} WHERE consumer=$1 ORDER BY ${order}`,
    [ctx.consumerId])).rows));
  const counters = async () => (await admin.query(`SELECT c.fact_used,c.worker_slots,c.issuer_slots,b.used AS service_used
    FROM ag_kernel.consumers c CROSS JOIN ag_kernel.fact_budget b WHERE c.consumer=$1`, [ctx.consumerId])).rows[0];
  const beforeRows = await rows(), beforeCounters = await counters();
  const incomingLease = (await admin.query('SELECT lease_until FROM ag_kernel.workers WHERE consumer=$1 AND worker=$2',
    [ctx.consumerId, incoming])).rows[0].lease_until;
  await assert.rejects(kernel.heartbeat(ctx, incoming), isCode('denied'));
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.workers WHERE consumer=$1', [ctx.consumerId]), facts.workerSlots);
  assert.deepEqual((await admin.query('SELECT lease_until FROM ag_kernel.workers WHERE consumer=$1 AND worker=$2',
    [ctx.consumerId, incoming])).rows[0].lease_until, incomingLease);

  let fresh = '';
  for (let n = 0; n < facts.workerSlots * 2; n++) {
    // Re-enroll a previously reclaimed orphan once; no accepted work used it.
    fresh = n === 1 ? orphans[0] : randomUUID();
    await kernel.heartbeat(ctx, fresh); // Old code denies here at its full eight slots.
    await kernel.heartbeat(ctx, live);
    const actual = (await admin.query('SELECT worker FROM ag_kernel.workers WHERE consumer=$1', [ctx.consumerId])).rows;
    assert.deepEqual(actual.map(row => row.worker).sort(), [...referenced, live, fresh].sort());
    assert.deepEqual(await rows(), beforeRows, 'all accepted authority and unknown/terminal effects survive reclaim');
    assert.deepEqual(await counters(), beforeCounters, 'worker slot reuse neither refunds nor charges facts');
    assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.workers WHERE consumer=$1 AND worker=$2',
      [foreign.consumerId, incoming]), 1, 'reclaim is consumer-scoped');
    if (n + 1 < facts.workerSlots * 2) await admin.query(`UPDATE ag_kernel.workers
      SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2`, [ctx.consumerId, fresh]);
  }
  await admin.query(`UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second'
    WHERE consumer=$1 AND worker=$2`, [ctx.consumerId, fresh]);
  const available = await count(`SELECT c.worker_slots-(SELECT count(*) FROM ag_kernel.workers w WHERE w.consumer=c.consumer)
    +(SELECT count(*) FROM ag_kernel.workers w WHERE w.consumer=c.consumer AND w.worker=$2 AND w.lease_until<=clock_timestamp()) AS n
    FROM ag_kernel.consumers c WHERE c.consumer=$1`, [ctx.consumerId, fresh]);
  assert.equal(available, 3, 'fixture has two vacant slots and one expired unreferenced enrollment');
  const peer = new PostgresKernel(poolB, { ...defaults, workerLeaseMs: 300_000 }, facts);
  const raced = await Promise.allSettled([kernel, peer, kernel, peer].map(k => k.heartbeat(ctx, randomUUID())));
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, available);
  const denied = raced.filter(r => r.status === 'rejected');
  assert.equal(denied.length, 1); assert.ok(denied[0]?.status === 'rejected' && isCode('denied')(denied[0].reason));
  const finalWorkers = (await admin.query('SELECT worker FROM ag_kernel.workers WHERE consumer=$1', [ctx.consumerId])).rows;
  assert.equal(finalWorkers.length, facts.workerSlots);
  assert.deepEqual(finalWorkers.filter(row => [...referenced, live].includes(row.worker)).map(row => row.worker).sort(), [...referenced, live].sort());
  assert.deepEqual(await counters(), beforeCounters); assert.deepEqual(await rows(), beforeRows);
  for (const expired of referenced) await assert.rejects(kernel.heartbeat(ctx, expired), isCode('denied'));
  assert.deepEqual(await kernel.requestProof(ctx, execution.result.executionRef!, 'held-unknown'), claimed.dispatch.closure);
  assert.equal((await kernel.request(ctx, execution.result.executionRef!, 'held-unknown')).effect, 'effect_unknown');
});

// Regression: replaying one spent native nonce on a different request/execution
// ID after closure must not convert its original reservation into another permit.
test('B2a a spent native reservation cannot move onto fresh request identities', async () => {
  const ctx = context(), account = await connected(ctx), w = await worker(ctx);
  const e = await prepared(ctx, account.accountRef!), native = reservation();
  const first = await a.claim(ctx, e.result.executionRef!, 'nonce-first', w, e.admission, native);
  assert.ok(first.dispatch);
  await a.effect(ctx, e.result.executionRef!, 'nonce-first', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'nonce-first', w, 'completed');
  await a.acknowledgeTransportClosed(ctx, w, first.dispatch.closure);
  await assert.rejects(b.claim(ctx, e.result.executionRef!, 'nonce-replayed', w, e.admission, native), isCode('denied'));
  const another = await prepared(ctx, account.accountRef!);
  await assert.rejects(b.claim(ctx, another.result.executionRef!, 'cross-execution', w, another.admission, native), isCode('denied'));
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 1);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, another.result.executionRef]), 0);
  const legitimate = await b.claim(ctx, e.result.executionRef!, 'nonce-new', w, e.admission,
    { ...native, requestNonce: randomUUID() });
  assert.ok(legitimate.dispatch);
  assert.equal(await count('SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]), 2);
});


// Regression: a legacy SQL002 token without native authority must not occupy
// every bounded cleanup page ahead of newer requests with provable closure.
test('B2a bounded cleanup prioritizes complete native proofs over legacy tokens', async () => {
  const bounds = { ...defaults, maxConcurrent: 2, maintenanceBatch: 1 };
  const x = new PostgresKernel(poolA, bounds);
  const ctx = context(), account = await connected(ctx), owner = await worker(ctx, x), delegate = await worker(ctx, x);
  const e = await prepared(ctx, account.accountRef!, {
    limits: { requests: 4, concurrency: 2, requestBytes: 4096, outputBytes: 8192, tokens: 5000 },
  }, x);
  const claim = await x.claim(ctx, e.result.executionRef!, 'Z-bound', owner, e.admission, reservation());
  assert.ok(claim.dispatch);
  await x.rejectBeforeDispatch(ctx, owner, claim.dispatch.closure, false);
  const legacyToken = randomUUID();
  await admin.query(`INSERT INTO ag_kernel.requests(consumer,execution_ref,id,effect,worker,closure_token)
    VALUES ($1,$2,'A-legacy-token','completed',$3,$4)`, [ctx.consumerId, e.result.executionRef, owner, legacyToken]);
  await admin.query('UPDATE ag_kernel.executions SET request_count=2 WHERE consumer=$1 AND ref=$2',
    [ctx.consumerId, e.result.executionRef]);
  await x.close(ctx, op(), e.result.executionRef!);
  const job = await x.claimCleanup(ctx, delegate); assert.ok(job && job.scope.kind === 'execution');
  assert.deepEqual(job.scope.transports, [claim.dispatch.closure]);
  const authority = { cleanupRef: job.cleanupRef, token: job.token };
  await x.acknowledgeTransportClosed(ctx, delegate, job.scope.transports[0], authority);
  const remaining = await x.cleanupTransports(ctx, job.cleanupRef, delegate, job.token);
  assert.deepEqual(remaining, [{ executionRef: e.result.executionRef, requestRef: 'A-legacy-token',
    worker: owner, token: legacyToken }]);
  await assert.rejects(x.acknowledgeTransportClosed(ctx, delegate, remaining[0], authority), isCode('invalid'));
  await assert.rejects(x.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true), isCode('conflict'));
  assert.equal(await occupancy(ctx, account.accountRef!), 1);
});

// Red when concurrent new IDs overrun an aggregate final slot, or saturation
// stores attacker denial rows / prevents an existing run's exact closure.
test('D-final final consumer fact slot is atomic and safety headroom is bounded', async () => {
  const ctx = context();
  const facts = { ...factDefaults, maxConsumerFacts: 28, maxAccountFacts: 28, workerSlots: 4, issuerSlots: 4 };
  const x = new PostgresKernel(poolA, defaults, facts), y = new PostgresKernel(poolB, defaults, facts);
  await x.issuer(ctx); // Provision bounded recovery slots before ordinary helpers.
  const account = await connected(ctx, x), owner = await worker(ctx, x);
  const original = await prepared(ctx, account.accountRef!, {}, x);
  const first = await x.claim(ctx, original.result.executionRef!, 'spent-at-cap', owner, original.admission, reservation());
  assert.ok(first.dispatch);
  const intents = await Promise.all([approval(ctx, account.accountRef!, {}, x), approval(ctx, account.accountRef!, {}, x)]);
  const results = await Promise.allSettled([x.prepare(ctx, intents[0]), y.prepare(ctx, intents[1])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const denied = results.find(r => r.status === 'rejected');
  assert.ok(denied?.status === 'rejected' && isCode('denied')(denied.reason));
  const budget = async () => (await admin.query(`SELECT fact_used FROM ag_kernel.consumers WHERE consumer=$1`, [ctx.consumerId])).rows[0].fact_used;
  assert.equal(Number(await budget()), 28);
  const rows = await count('SELECT count(*) AS n FROM ag_kernel.operations WHERE consumer=$1', [ctx.consumerId]);
  for (let n = 0; n < 3; n++) {
    await assert.rejects(y.prepare(ctx, await approval(ctx, account.accountRef!, {}, x)), isCode('denied'));
    await assert.rejects(x.claim(ctx, original.result.executionRef!, 'new-denial-' + n, owner, original.admission, reservation()), isCode('denied'));
  }
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.operations WHERE consumer=$1', [ctx.consumerId]), rows);
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.requests WHERE consumer=$1', [ctx.consumerId]), 1);
  assert.deepEqual(await y.prepare(ctx, original.input), original.result);
  await assert.rejects(x.prepare(ctx, { ...original.input, intentDigest: digest() }), isCode('conflict'));
  assert.deepEqual(await y.operation(ctx, original.input.operationId), original.result);
  assert.deepEqual((await y.savedExecution(ctx, original.result.executionRef!)).admission, original.admission);
  const rejected = await x.rejectBeforeDispatch(ctx, owner, first.dispatch.closure, false);
  assert.deepEqual(await y.claim(ctx, original.result.executionRef!, 'spent-at-cap', owner, original.admission, reservation()), { status: rejected });
  const closeId = op();
  const closed = await y.close(ctx, closeId, original.result.executionRef!);
  assert.equal(closed.state, 'applied');
  assert.deepEqual(await x.close(ctx, closeId, original.result.executionRef!), closed);
  await assert.rejects(y.close(ctx, op(), original.result.executionRef!), isCode('denied'));
  const fenceId = op(), fenced = await x.fence(ctx, fenceId, 'binding-fixture', 2);
  assert.equal(fenced.state, 'applied');
  assert.deepEqual(await y.fence(ctx, fenceId, 'binding-fixture', 2), fenced);
  for (let n = 0; n < 3; n++) await assert.rejects(y.fence(ctx, op(), 'binding-fixture', 3 + n), isCode('denied'));
  const disabled = await x.beginAccount(ctx, { operationId: op(), kind: 'disable', intentDigest: digest(),
    accountRef: account.accountRef!, expectedRevision: account.revision! });
  assert.equal(disabled.state, 'applied');
  const delegate = await worker(ctx, y);
  const cleanupJobs: CleanupClaim[] = [];
  let found = false;
  for (let n = 0; n < 3; n++) {
    const job = await y.claimCleanup(ctx, delegate); assert.ok(job);
    cleanupJobs.push(job);
    if (job.scope.kind === 'generation') {
      await assert.rejects(y.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true), isCode('conflict'));
    }
  }
  for (const job of cleanupJobs) {
    if (job.scope.kind === 'execution' && job.scope.executionRef === original.result.executionRef) {
      assert.deepEqual(job.scope.transports, [first.dispatch.closure]);
      await x.acknowledgeTransportClosed(ctx, delegate, job.scope.transports[0], { cleanupRef: job.cleanupRef, token: job.token });
      found = true;
    }
  }
  assert.ok(found);
  assert.equal(await occupancy(ctx, account.accountRef!), 0);
  for (const job of cleanupJobs) await y.settleCleanup(ctx, job.cleanupRef, delegate, job.token, true);
  assert.deepEqual(await x.request(ctx, original.result.executionRef!, 'spent-at-cap'), rejected);
  assert.equal(Number(await budget()), 28, 'prepaid safety mutations cannot increase the budget');
});

type RetentionFixture = { ctx: TrustedContext; owner: string; safe: Awaited<ReturnType<typeof prepared>>;
  unknown: Awaited<ReturnType<typeof prepared>>; safeProof: NativeDispatchProof; unknownProof: NativeDispatchProof };
let retentionFixture: RetentionFixture;
// Red when expiry alone compacts unresolved authority, or positively closed,
// expired runs never compact their redundant intents while readback stays full.
test('D-final only expired positively safe payloads compact; held evidence survives', async () => {
  const ctx = context(), owner = await worker(ctx);
  const cases = ['safe', 'unknown', 'occupied', 'cleanup-pending'] as const;
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const deadline = new Date(now.getTime() + 2_000);
  const executions = new Map<string, Awaited<ReturnType<typeof prepared>>>();
  const proofs = new Map<string, NativeDispatchProof>();
  for (const kind of cases) {
    const account = await connected(ctx);
    const e = await prepared(ctx, account.accountRef!, { deadline });
    const claimed = await a.claim(ctx, e.result.executionRef!, kind, owner, e.admission, reservation());
    assert.ok(claimed.dispatch);
    executions.set(kind, e); proofs.set(kind, claimed.dispatch.closure);
    if (kind === 'unknown') await a.effect(ctx, e.result.executionRef!, kind, owner, 'effect_unknown');
    else {
      await a.effect(ctx, e.result.executionRef!, kind, owner, 'response_started');
      await a.effect(ctx, e.result.executionRef!, kind, owner, 'completed');
    }
    await a.close(ctx, op(), e.result.executionRef!);
    if (kind === 'safe' || kind === 'cleanup-pending') await a.acknowledgeTransportClosed(ctx, owner, claimed.dispatch.closure);
  }
  for (let n = 0; n < cases.length; n++) {
    const job = await b.claimCleanup(ctx, owner); assert.ok(job?.scope.kind === 'execution');
    if (job.scope.executionRef === executions.get('safe')!.result.executionRef) await b.settleCleanup(ctx, job.cleanupRef, owner, job.token, true);
  }
  const payloads = async () => (await admin.query(`SELECT ref,intent,intent_hash FROM ag_kernel.executions
    WHERE consumer=$1 ORDER BY ref`, [ctx.consumerId])).rows;
  const before = await payloads();
  assert.ok(before.every(row => row.intent !== null));
  const used = await count('SELECT fact_used AS n FROM ag_kernel.consumers WHERE consumer=$1', [ctx.consumerId]);
  await delay(Math.max(0, deadline.getTime() - Date.now()) + 50);
  await a.reconcile(ctx);
  const after = await payloads(), safe = executions.get('safe')!, unknown = executions.get('unknown')!;
  for (const row of after) {
    const old = before.find(r => r.ref === row.ref)!;
    assert.deepEqual(row.intent_hash, old.intent_hash);
    if (row.ref === safe.result.executionRef) assert.equal(row.intent, null);
    else assert.deepEqual(row.intent, old.intent, 'equally old unresolved rows must retain their metadata');
  }
  const operationPayload = (await admin.query('SELECT intent,intent_hash FROM ag_kernel.operations WHERE consumer=$1 AND id=$2',
    [ctx.consumerId, safe.input.operationId])).rows[0];
  assert.equal(operationPayload.intent, null); assert.equal(operationPayload.intent_hash.length, 32);
  assert.deepEqual(await b.prepare(ctx, safe.input), safe.result);
  await assert.rejects(b.prepare(ctx, { ...safe.input, intentDigest: digest() }), isCode('conflict'));
  assert.deepEqual(await b.operation(ctx, safe.input.operationId), safe.result);
  assert.deepEqual((await b.savedExecution(ctx, safe.result.executionRef!)).admission, safe.admission);
  assert.equal((await b.savedExecution(ctx, safe.result.executionRef!)).dispatchAllowed, false);
  assert.equal((await b.request(ctx, unknown.result.executionRef!, 'unknown')).effect, 'effect_unknown');
  assert.deepEqual(await b.requestProof(ctx, unknown.result.executionRef!, 'unknown'), proofs.get('unknown'));
  assert.equal(await occupancy(ctx, unknown.result.accountRef!), 1);
  assert.equal(await count('SELECT fact_used AS n FROM ag_kernel.consumers WHERE consumer=$1', [ctx.consumerId]), used);
  retentionFixture = { ctx, owner, safe, unknown, safeProof: proofs.get('safe')!, unknownProof: proofs.get('unknown')! };
});

// Red when restart/restore forgets replay tombstones, unknown invocation/native
// nonce bindings or old issuer epochs, or service/account caps ignore real rows.
test('D-final tombstones and spent proofs survive restart/restore and all aggregate caps', async () => {
  assert.ok(retentionFixture);
  const { ctx, owner, safe, unknown, safeProof, unknownProof } = retentionFixture;
  const used = await count('SELECT fact_used AS n FROM ag_kernel.consumers WHERE consumer=$1', [ctx.consumerId]);
  const saturated = new PostgresKernel(poolB, defaults, { ...factDefaults, maxConsumerFacts: used, maxAccountFacts: used });
  const beforeIssuer = await saturated.issuer(ctx);
  // Actual logical backup into a NEW disposable DB, separately from normal
  // kernel reconstruction. Never export the dump or CLI vendor diagnostics.
  const restoredDatabase = database + '_restore';
  assert.match(restoredDatabase, /^ag_kernel_test_[a-z0-9_]+$/);
  const dumpExecutable = process.env.AG_KERNEL_TEST_PG_DUMP, psqlExecutable = process.env.AG_KERNEL_TEST_PSQL;
  assert.ok(typeof dumpExecutable === 'string' && dumpExecutable.startsWith('/') && dumpExecutable.endsWith('/pg_dump'));
  assert.ok(typeof psqlExecutable === 'string' && psqlExecutable.startsWith('/') && psqlExecutable.endsWith('/psql'));
  await admin.query(`CREATE DATABASE "${restoredDatabase}"`);
  const restoredURL = new URL(safeTestDsn()); restoredURL.pathname = '/' + restoredDatabase;
  const cliEnv = (url: URL): NodeJS.ProcessEnv => ({ ...process.env, PGHOST: url.hostname,
    PGPORT: url.port, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)) });
  let stage = 'dump';
  try {
    const dump = execFileSync(dumpExecutable, ['--no-owner', '--no-acl', '--schema=ag_kernel', '--schema=ag_management'],
      { env: cliEnv(new URL(safeTestDsn())), maxBuffer: 16_777_216, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    stage = 'restore';
    execFileSync(psqlExecutable, ['--no-psqlrc', '--set=ON_ERROR_STOP=on'],
      { env: cliEnv(restoredURL), input: dump, maxBuffer: 1_048_576,
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
  } catch { throw new Error(`disposable ${stage} failed; vendor diagnostics withheld`); }
  const restoredPool = new pg.Pool({ connectionString: restoredURL.toString(), max: 1 });
  try {
    const restored = new PostgresKernel(restoredPool);
    assert.equal(await restored.issuer(ctx), beforeIssuer);
    await restored.restore(ctx, beforeIssuer, randomUUID());
    assert.deepEqual(await restored.prepare(ctx, safe.input), safe.result);
    assert.deepEqual(await restored.prepare(ctx, unknown.input), unknown.result);
    await assert.rejects(restored.prepare(ctx, { ...safe.input, operationId: op() }), isCode('denied'));
    await assert.rejects(restored.prepare(ctx, { ...unknown.input, operationId: op(), intentDigest: digest() }), isCode('conflict'));
    assert.equal((await restored.claim(ctx, safe.result.executionRef!, 'safe', owner, safe.admission, reservation())).dispatch, undefined);
    assert.equal((await restored.claim(ctx, unknown.result.executionRef!, 'unknown', owner, unknown.admission, reservation())).status.effect, 'effect_unknown');
    await assert.rejects(restored.claim(ctx, safe.result.executionRef!, 'restored-new-id', owner, safe.admission, reservation()), isCode('denied'));
    assert.deepEqual(await restored.requestProof(ctx, safe.result.executionRef!, 'safe'), safeProof);
    assert.deepEqual(await restored.requestProof(ctx, unknown.result.executionRef!, 'unknown'), unknownProof);
    assert.equal((await restored.savedExecution(ctx, safe.result.executionRef!)).dispatchAllowed, false);
  } finally { await restoredPool.end(); }
  await saturated.restore(ctx, beforeIssuer, randomUUID());
  const restarted = new PostgresKernel(poolA);
  assert.deepEqual(await restarted.prepare(ctx, safe.input), safe.result);
  assert.deepEqual(await restarted.prepare(ctx, unknown.input), unknown.result);
  await assert.rejects(restarted.prepare(ctx, { ...safe.input, operationId: op() }), isCode('denied'));
  await assert.rejects(restarted.prepare(ctx, { ...unknown.input, operationId: op(), intentDigest: digest() }), isCode('conflict'));
  assert.deepEqual(await restarted.claim(ctx, safe.result.executionRef!, 'safe', owner, safe.admission, reservation()),
    { status: { requestRef: 'safe', effect: 'completed' } });
  assert.equal((await restarted.claim(ctx, unknown.result.executionRef!, 'unknown', owner, unknown.admission, reservation())).status.effect, 'effect_unknown');
  await assert.rejects(restarted.claim(ctx, safe.result.executionRef!, 'new-after-restore', owner, safe.admission, reservation()), isCode('denied'));
  assert.deepEqual(await restarted.requestProof(ctx, safe.result.executionRef!, 'safe'), safeProof);
  assert.deepEqual(await restarted.requestProof(ctx, unknown.result.executionRef!, 'unknown'), unknownProof);
  assert.equal((await restarted.savedExecution(ctx, safe.result.executionRef!)).dispatchAllowed, false);
  await assert.rejects(restarted.restore(ctx, await restarted.issuer(ctx), beforeIssuer), isCode('conflict'));
  // The finite prepaid recovery slots bound new boot/restore identities as well.
  for (let n = 0; n < factDefaults.issuerSlots - 2; n++) await restarted.restore(ctx, await restarted.issuer(ctx), randomUUID());
  await assert.rejects(restarted.restore(ctx, await restarted.issuer(ctx), randomUUID()), isCode('denied'));
  let workers = await count('SELECT count(*) AS n FROM ag_kernel.workers WHERE consumer=$1', [ctx.consumerId]);
  while (workers++ < factDefaults.workerSlots) await worker(ctx, restarted);
  await assert.rejects(worker(ctx, restarted), isCode('denied'));
  await restarted.heartbeat(ctx, owner);
  assert.equal(await count('SELECT fact_used AS n FROM ag_kernel.consumers WHERE consumer=$1', [ctx.consumerId]), used);
  assert.equal((await restarted.request(ctx, unknown.result.executionRef!, 'unknown')).effect, 'effect_unknown');
  assert.equal(await occupancy(ctx, unknown.result.accountRef!), 1);

  const accountCtx = context(); await a.issuer(accountCtx);
  const account = await connected(accountCtx);
  const accountUsed = await count('SELECT fact_used AS n FROM ag_kernel.accounts WHERE consumer=$1 AND ref=$2', [accountCtx.consumerId, account.accountRef]);
  const accountCapped = new PostgresKernel(poolA, defaults, { ...factDefaults, maxAccountFacts: accountUsed });
  await assert.rejects(accountCapped.prepare(accountCtx, await approval(accountCtx, account.accountRef!)), isCode('denied'));
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.executions WHERE consumer=$1', [accountCtx.consumerId]), 0);
  assert.equal((await accountCapped.beginAccount(accountCtx, { operationId: op(), kind: 'disable', intentDigest: digest(),
    accountRef: account.accountRef!, expectedRevision: account.revision! })).state, 'applied');

  // Last test intentionally saturates the shared service counter across consumers.
  const left = context(), right = context();
  const accounts = await Promise.all([connected(left), connected(right)]);
  const inputs = await Promise.all([approval(left, accounts[0].accountRef!), approval(right, accounts[1].accountRef!)]);
  const serviceUsed = await count('SELECT used AS n FROM ag_kernel.fact_budget', []);
  const globalFacts = { ...factDefaults, maxServiceFacts: serviceUsed + 6, maxConsumerFacts: serviceUsed + 6, maxAccountFacts: Math.min(10_000, serviceUsed + 6) };
  const x = new PostgresKernel(poolA, defaults, globalFacts), y = new PostgresKernel(poolB, defaults, globalFacts);
  const results = await Promise.allSettled([x.prepare(left, inputs[0]), y.prepare(right, inputs[1])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.some(r => r.status === 'rejected' && isCode('denied')(r.reason)));
  const accepted = results.findIndex(r => r.status === 'fulfilled');
  const winner = results[accepted]; assert.ok(winner.status === 'fulfilled');
  const winCtx = accepted === 0 ? left : right;
  assert.equal((await x.close(winCtx, op(), winner.value.executionRef!)).state, 'applied');
  const deniedConsumer = context();
  await assert.rejects(y.issuer(deniedConsumer), isCode('denied'));
  assert.equal(await count('SELECT count(*) AS n FROM ag_kernel.consumers WHERE consumer=$1', [deniedConsumer.consumerId]), 0);
  assert.equal(await count('SELECT used AS n FROM ag_kernel.fact_budget', []), serviceUsed + 6);
  assert.deepEqual(await y.operation(winCtx, inputs[accepted].operationId), winner.value);
});
