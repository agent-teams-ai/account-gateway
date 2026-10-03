import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresKernel } from '../src/postgres.ts';
import { KernelError, defaults } from '../src/domain.ts';
import type { TrustedContext, AccountIntent, ApprovedPreparation, OperationStatus, PrivateAdmission } from '../src/domain.ts';

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
before(async () => {
  const connectionString = safeTestDsn();
  admin = new pg.Pool({ connectionString, max: 2 });
  poolA = new pg.Pool({ connectionString, max: 1 });
  poolB = new pg.Pool({ connectionString, max: 1 });
  try {
    const v = await admin.query("SELECT current_database() AS db,current_setting('server_version') AS version");
    assert.equal(v.rows[0].db, database);
    assert.match(v.rows[0].version, /^17\.10(?:$| )/);
    const exists = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='ag_kernel'");
    assert.equal(exists.rowCount, 0, 'requires NEW disposable database; never overwrite an existing schema');
    await admin.query(await readFile(new URL('../migrations/001_kernel.sql', import.meta.url), 'utf8'));
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

const context = (): TrustedContext => ({ consumerId: 'test-' + randomUUID() });
const op = (): string => randomUUID();
const digest = (): string => 'safe-ingress-' + randomUUID();
const isCode = (code: string) => (e: unknown): boolean => e instanceof KernelError && e.code === code;
async function worker(ctx: TrustedContext, kernel = a): Promise<string> {
  const id = randomUUID(); await kernel.heartbeat(ctx, id); return id;
}
async function staged(ctx: TrustedContext, overrides: Partial<AccountIntent> = {}): Promise<OperationStatus> {
  return a.beginAccount(ctx, { operationId: op(), kind: 'create', intentDigest: digest(),
    ownerRef: 'workspace-fixture', profile: 'mimo-test', displayName: 'Disposable connection', ...overrides });
}
async function connected(ctx: TrustedContext): Promise<OperationStatus> {
  const s = await staged(ctx); const w = await worker(ctx);
  const c = await a.startCandidate(ctx, s.operationRef, w); assert.ok(c);
  return a.acknowledgeCandidate(ctx, s.operationRef, w, {
    generation: c.candidate, nativePhysicalIdentity: randomUUID(), profile: c.profile,
  });
}
async function approval(ctx: TrustedContext, accountRef: string, override: Partial<ApprovedPreparation> = {}): Promise<ApprovedPreparation> {
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  return { operationId: op(), intentDigest: digest(), invocationRef: op(), attemptRef: 'attempt-a',
    permittedAccounts: [accountRef], profile: 'mimo-test', policySubject: 'binding-fixture', policyRevision: 1, bindingRevision: 0,
    issuerEpoch: await a.issuer(ctx), deadline: new Date(now.getTime() + 60_000),
    limits: { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 }, ...override };
}
function admissionFor(input: ApprovedPreparation, result: OperationStatus, accountRef: string): PrivateAdmission {
  return { executionRef: result.executionRef!, accountRef, subjectRef: input.policySubject,
    invocationRef: input.invocationRef, attemptRef: input.attemptRef, profileId: input.profile,
    issuerEpoch: input.issuerEpoch, authorizationEpoch: result.epoch!, policyRevision: input.policyRevision,
    bindingRevision: input.bindingRevision, limits: { ...input.limits }, expiresAt: input.deadline.toISOString() };
}
async function prepared(ctx: TrustedContext, accountRef: string, override: Partial<ApprovedPreparation> = {}, kernel = a) {
  const input = await approval(ctx, accountRef, override);
  const result = await kernel.prepare(ctx, input); assert.ok(result.executionRef); assert.ok(result.epoch);
  return { input, result, admission: admissionFor(input, result, accountRef) };
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
    let blocked = false;
    for (let n = 0; n < 200; n++) {
      const seen = await gate.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND wait_event_type='Lock'", [pids]);
      if (seen.rows[0].n === 2) { blocked = true; break; }
      await delay(10);
    }
    await gate.query('COMMIT');
    const results = await pair;
    assert.equal(blocked, true, 'both distinct sessions must reach the DB barrier');
    return results;
  } finally { await gate.query('ROLLBACK'); gate.release(); }
}
async function count(sql: string, values: unknown[]) {
  return (await admin.query(sql, values)).rows[0].n as number;
}

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
  const oldClaim = await b.claim(ctx, e.result.executionRef!, 'old-before-promotion', w, e.admission);
  assert.ok(oldClaim.dispatch);
  assert.equal(oldClaim.dispatch.descriptor.generation, c.candidate);
  const promoted = await a.acknowledgeCandidate(ctx, reconnect.operationRef, w,
    { generation: pending.candidate, nativePhysicalIdentity: randomUUID(), profile: pending.profile });
  assert.equal(promoted.epoch, active.epoch! + 1);
  const denied = await b.claim(ctx, e.result.executionRef!, 'old-after-promotion', w, e.admission);
  assert.equal(denied.dispatch, undefined); assert.equal(denied.status.effect, 'not_dispatched');
  const e2 = await prepared(ctx, active.accountRef!, { invocationRef: op() });
  const stale = await a.beginAccount(ctx, { operationId: op(), kind: 'reconnect', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: promoted.revision });
  const sc = await a.startCandidate(ctx, stale.operationRef, w); assert.ok(sc);
  const renamed = await a.beginAccount(ctx, { operationId: op(), kind: 'rename', intentDigest: digest(),
    accountRef: active.accountRef, expectedRevision: promoted.revision, displayName: 'CAS winner' });
  const lost = await a.acknowledgeCandidate(ctx, stale.operationRef, w,
    { generation: sc.candidate, nativePhysicalIdentity: randomUUID(), profile: sc.profile });
  assert.equal(lost.state, 'rejected');
  assert.equal((await a.account(ctx, active.accountRef!)).revision, renamed.revision);
  const still = await a.claim(ctx, e2.result.executionRef!, 'still-sticky', w, e2.admission);
  assert.ok(still.dispatch); assert.equal(still.dispatch.descriptor.generation, pending.candidate);
});

// Red if a stale admitted envelope dispatches after the acknowledged fence,
// or fencing rewrites an already accepted effect.
test('fence linearizes against claim and preserves already accepted effects', async () => {
  const ctx = context(), account = await connected(ctx), e = await prepared(ctx, account.accountRef!);
  const w = await worker(ctx);
  const first = await a.claim(ctx, e.result.executionRef!, 'accepted', w, e.admission); assert.ok(first.dispatch);
  const f = await b.fence(ctx, 'fence-stable', e.input.policySubject, 2); assert.equal(f.state, 'applied');
  const stale = await a.claim(ctx, e.result.executionRef!, 'paused-envelope', w, e.admission);
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
    () => b.claim(ctx2, e2.result.executionRef!, 'racing', w2, e2.admission));
  assert.equal(pair.every(r => r.status === 'fulfilled'), true);
  const after = await a.claim(ctx2, e2.result.executionRef!, 'after-ack', w2, e2.admission);
  assert.equal(after.dispatch, undefined); assert.equal(after.status.effect, 'not_dispatched');
  // A distinct same-revision fence still closes previously issued admissions;
  // revision equality must never produce a false acknowledged fence.
  const ctx3 = context(), ac3 = await connected(ctx3), e3 = await prepared(ctx3, ac3.accountRef!), w3 = await worker(ctx3);
  assert.equal((await b.fence(ctx3, 'same-revision', e3.input.policySubject, 1)).state, 'applied');
  assert.equal((await a.claim(ctx3, e3.result.executionRef!, 'previously-issued', w3, e3.admission)).dispatch, undefined);
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
  const claims = await race(ctx, () => a.claim(ctx, e.executionRef!, 'same-request', w1, admission),
    () => b.claim(ctx, e.executionRef!, 'same-request', w2, admission));
  assert.equal(claims.every(r => r.status === 'fulfilled'), true);
  assert.equal(claims.filter(r => r.status === 'fulfilled' && r.value.dispatch).length, 1);
  const winner = claims[0].status === 'fulfilled' && claims[0].value.dispatch ? w1 : w2;
  const duplicate = await b.claim(ctx, e.executionRef!, 'same-request', w2, admission);
  assert.equal(duplicate.dispatch, undefined); assert.equal(duplicate.status.requestRef, 'same-request');
  await a.effect(ctx, e.executionRef!, 'same-request', winner, 'response_started');
  await b.effect(ctx, e.executionRef!, 'same-request', winner, 'effect_unknown');
  const fresh = await a.claim(ctx, e.executionRef!, op(), w1, admission);
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
  const misbound = await b.claim(ctx, other.result.executionRef!, 'wrong-envelope', w, e.admission);
  assert.equal(misbound.dispatch, undefined); assert.equal(misbound.status.code, 'fenced');
  const pair = await race(ctx, () => a.claim(ctx, e.result.executionRef!, 'one', w, e.admission),
    () => b.claim(ctx, e.result.executionRef!, 'two', w, e.admission));
  assert.equal(pair.every(r => r.status === 'fulfilled'), true);
  assert.equal(pair.filter(r => r.status === 'fulfilled' && r.value.dispatch).length, 1);
  const first = pair[0].status === 'fulfilled' && pair[0].value.dispatch ? 'one' : 'two';
  const denied = first === 'one' ? 'two' : 'one';
  await assert.rejects(a.effect(ctx, e.result.executionRef!, first, w, 'completed'), isCode('conflict'));
  await a.effect(ctx, e.result.executionRef!, first, w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, first, w, 'completed');
  assert.equal((await b.claim(ctx, e.result.executionRef!, denied, w, e.admission)).dispatch, undefined);
  assert.ok((await a.claim(ctx, e.result.executionRef!, 'third', w, e.admission)).dispatch);
  await a.effect(ctx, e.result.executionRef!, 'third', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'third', w, 'completed');
  const total = await b.claim(ctx, e.result.executionRef!, 'fourth', w, e.admission);
  assert.equal(total.status.code, 'limit'); assert.equal(total.status.effect, 'not_dispatched');
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!, { limits: { ...e.input.limits, requests: 0 } })), isCode('invalid'));
  // Red if pretransaction validation throws outside the Promise port or admits zero limits.
  await assert.rejects(b.prepare(ctx, await approval(ctx, account.accountRef!, { limits: { ...e.input.limits, concurrency: 0 } })), isCode('invalid'));
  await assert.rejects(a.account(ctx, 'invalid-uuid'), isCode('invalid'));
  await assert.rejects(b.restore(ctx, e.admission.issuerEpoch, e.admission.issuerEpoch), isCode('invalid'));
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!, { deadline: new Date(now.getTime() - 1) })), isCode('denied'));
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!, { deadline: new Date(now.getTime() + 3_700_000) })), isCode('denied'));
  const freshNow = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const short = await prepared(ctx, account.accountRef!, { deadline: new Date(freshNow.getTime() + 3_000) });
  const gate = await admin.connect();
  let expired;
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [ctx.consumerId]);
    const waiting = a.claim(ctx, short.result.executionRef!, 'late', w, short.admission);
    // Prevent an unhandled rejection while the actual transaction is blocked.
    const outcome = waiting.then(value => ({ value }), () => ({ value: undefined }));
    let blocked = false;
    for (let n = 0; n < 200; n++) {
      const seen = await gate.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pids[0]]);
      if (seen.rowCount) { blocked = true; break; }
      await delay(10);
    }
    assert.equal(blocked, true);
    // Clock advances AFTER claim transaction start, BEFORE its row lock release.
    // CURRENT_TIMESTAMP would incorrectly accept this request after the wait.
    await gate.query('SELECT pg_sleep(3.1)');
    await gate.query('COMMIT');
    expired = (await outcome).value;
    assert.ok(expired);
  } finally { await gate.query('ROLLBACK'); gate.release(); }
  assert.equal(expired.status.code, 'deadline'); assert.equal(expired.dispatch, undefined);
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2',
    [ctx.consumerId, short.result.executionRef]), 1);
});

// Red if startup rotates all grants, expired ownership retries inference,
// incomplete candidates become active, or restore is treated like restart.
test('restart reconciles only lost claims; explicit restore rotates and quarantines', async () => {
  const ctx = context(), account = await connected(ctx);
  const healthy = await prepared(ctx, account.accountRef!), dead = await prepared(ctx, account.accountRef!);
  const liveWorker = await worker(ctx), deadWorker = await worker(ctx);
  assert.ok((await a.claim(ctx, healthy.result.executionRef!, 'live', liveWorker, healthy.admission)).dispatch);
  assert.ok((await b.claim(ctx, dead.result.executionRef!, 'orphan', deadWorker, dead.admission)).dispatch);
  const pending = await staged(ctx), c = await a.startCandidate(ctx, pending.operationRef, deadWorker); assert.ok(c);
  await admin.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
    [ctx.consumerId, deadWorker]);
  await poolA.end();
  poolA = new pg.Pool({ connectionString: safeTestDsn(), max: 1 });
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
  assert.equal((await a.claim(ctx, dead.result.executionRef!, 'fresh-orphan-id', liveWorker, dead.admission)).dispatch, undefined);
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
  assert.equal((await a.claim(ctx, healthy.result.executionRef!, 'old-grant', liveWorker, healthy.admission)).dispatch, undefined);
  await assert.rejects(a.restore(ctx, freshIssuer, originalIssuer), isCode('conflict'));
  await assert.rejects(a.prepare(ctx, await approval(ctx, account.accountRef!)), isCode('unknown'));
});

// Red if cleanup dies with capability/owner, two workers settle the same lease,
// a stale token settles reclaimed work, or cleanup reactivates a disabled account.
test('disable and idempotent close persist bounded scoped cleanup across worker loss', async () => {
  const ctx = context(), account = await connected(ctx), e = await prepared(ctx, account.accountRef!);
  const w1 = await worker(ctx), w2 = await worker(ctx);
  assert.ok((await a.claim(ctx, e.result.executionRef!, 'accepted', w1, e.admission)).dispatch);
  const disabled = await a.beginAccount(ctx, { operationId: 'disable', kind: 'disable', intentDigest: digest(),
    accountRef: account.accountRef, expectedRevision: account.revision });
  assert.equal(disabled.state, 'applied');
  assert.equal((await b.claim(ctx, e.result.executionRef!, 'denied', w2, e.admission)).dispatch, undefined);
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
  await b.settleCleanup(ctx, reclaimed.cleanupRef, w2, reclaimed.token, true);
  await b.settleCleanup(ctx, j2.cleanupRef, w2, j2.token, true);
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
  await a.claim(ctx, e.result.executionRef!, 'request', w, e.admission);
  await assert.rejects(b.account(foreign, account.accountRef!), isCode('unknown'));
  await assert.rejects(b.account(foreign, randomUUID()), isCode('unknown'));
  await assert.rejects(b.operation(foreign, account.operationRef), isCode('unknown'));
  await assert.rejects(b.execution(foreign, e.result.executionRef!), isCode('unknown'));
  await assert.rejects(b.request(foreign, e.result.executionRef!, 'request'), isCode('unknown'));
  await assert.rejects(b.claim(foreign, e.result.executionRef!, 'new', w, e.admission), isCode('unknown'));
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
    const denied = await b.claim(ctx, e.result.executionRef!, 'stale-' + name, w, { ...e.admission, ...mutation });
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
  const accepted = await a.claim(ctx, e.result.executionRef!, 'offset-expiry', w, { ...e.admission, expiresAt: offset });
  assert.ok(accepted.dispatch);
  assert.deepEqual(accepted.dispatch.limits, { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 5000 });
  assert.equal(accepted.dispatch.deadline, e.input.deadline.toISOString());
  // A denied identity cannot later become a dispatch when its envelope is fixed.
  assert.equal((await a.claim(ctx, e.result.executionRef!, 'stale-binding', w, e.admission)).dispatch, undefined);
  await b.fence(ctx, 'zero-revision-fence', e.input.policySubject, 0);
  await a.effect(ctx, e.result.executionRef!, 'offset-expiry', w, 'response_started');
  await a.effect(ctx, e.result.executionRef!, 'offset-expiry', w, 'completed');
  const repeat = await b.claim(ctx, e.result.executionRef!, 'offset-expiry', w, { ...e.admission, bindingRevision: 1 });
  assert.equal(repeat.dispatch, undefined); assert.equal(repeat.status.effect, 'completed');
  assert.equal((await a.claim(ctx, e.result.executionRef!, 'after-zero-fence', w, e.admission)).dispatch, undefined);
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
  const accepted = await b.claim(ctx, e.result.executionRef!, 'full-range-binding', w, e.admission);
  assert.ok(accepted.dispatch, 'safe-integer revision must survive PostgreSQL bigint decoding');
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.executions WHERE consumer=$1', [ctx.consumerId]), 1);
  // New fields retain the asynchronous invalid-input contract.
  await assert.rejects(a.prepare(ctx, { ...e.input, operationId: op(),
    limits: { ...e.input.limits, concurrency: 3 } }), isCode('invalid'));
  await assert.rejects(b.claim(ctx, e.result.executionRef!, 'invalid-concurrency', w,
    { ...e.admission, limits: { ...e.input.limits, concurrency: 3 } }), isCode('invalid'));
  assert.equal(await count('SELECT count(*)::integer n FROM ag_kernel.requests WHERE consumer=$1 AND id=$2',
    [ctx.consumerId, 'invalid-concurrency']), 0);
  for (const field of ['requestBytes', 'outputBytes', 'tokens'] as const) {
    await assert.rejects(a.prepare(ctx, { ...e.input, operationId: op(), limits: { ...e.input.limits, [field]: 0 } }), isCode('invalid'));
  }
  await assert.rejects(b.prepare(ctx, { ...e.input, attemptRef: 1 } as unknown as ApprovedPreparation), isCode('invalid'));
  await assert.rejects(a.prepare(ctx, { ...e.input, bindingRevision: -1 }), isCode('invalid'));
  await assert.rejects(b.claim(ctx, e.result.executionRef!, 'invalid-limits', w,
    { ...e.admission, limits: { ...e.input.limits, tokens: Infinity } }), isCode('invalid'));
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
  const claim = await b.claim(ctx, won.executionRef, 'opaque-winner', w, envelope); assert.ok(claim.dispatch);
  assert.equal(claim.dispatch.limits.outputBytes, approved.limits.outputBytes);
  await a.effect(ctx, won.executionRef, 'opaque-winner', w, 'effect_unknown');
  assert.equal((await b.claim(ctx, won.executionRef, 'new-id', w, envelope)).dispatch, undefined);
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
