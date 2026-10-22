import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createFacade, FacadeBearers } from '../src/facade.ts';
import { PostgresKernel } from '../src/postgres.ts';
import { PostgresUsageJournal } from '../src/usage.ts';
import { ServiceAdmission, inServiceLane, sharedCheckout } from '../src/service-admission.ts';
import { AccountManagement } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { NativeManagementClient } from '../src/native-client.ts';

test('protected control facade usage keeps real PostgreSQL capacity for heartbeat and cleanup', { timeout: 20_000 }, async () => {
  const database = process.env.AG_USAGE_CAPACITY_DISPOSABLE_DB, dsn = process.env.AG_USAGE_CAPACITY_TEST_DSN;
  if (!database || !/^ag_usage_capacity_test_[a-z0-9_]+$/.test(database) || !dsn ||
      process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10') throw new Error('NOT_RUN: explicit new disposable PG17.10 DB required');
  const url = new URL(dsn);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + database || url.search || url.hash) throw new Error('refusing remote or unspecified fixture DB');
  const pool = new pg.Pool({ connectionString: dsn, max: 8, connectionTimeoutMillis: 2000,
    statement_timeout: 8000, application_name: 'usage_capacity_data' });
  const admin = new pg.Pool({ connectionString: dsn, max: 2, statement_timeout: 8000 });
  pool.on('error', () => undefined); admin.on('error', () => undefined);
  const kernel = new PostgresKernel(pool), usage = new PostgresUsageJournal(pool, randomBytes(32));
  const context = { consumerId: 'capacity-consumer' }, worker = randomUUID();
  const limits = { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 32 };
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32)), store = new PostgresManagementStore(pool, custody);
  const profile = { profile: 'fixture-profile', model: 'fixture-model', baseURL: 'https://fixture.invalid/v1', qualificationRef: 'synthetic-only' };
  const management = new AccountManagement({ kernel, store, custody, worker, profiles: [profile],
    native: new NativeManagementClient({ origin: 'http://127.0.0.1:1', consumerId: context.consumerId, controlCredential: 'synthetic-control' }),
    proof: { async verify() { throw new Error('no native/provider calls in read fixture'); } } });
  const token = 'fixture-consumer-control-' + randomUUID(), other = 'fixture-other-consumer-' + randomUUID(), run = 'fixture-run-control-' + randomUUID();
  const bearers = new FacadeBearers([
    { role: 'consumer-control', token, consumerId: context.consumerId, profileIds: [profile.profile], limits, maxRunMs: 1000 },
    { role: 'consumer-control', token: other, consumerId: 'other-consumer', profileIds: [profile.profile], limits, maxRunMs: 1000 },
    { role: 'run-control', token: run, consumerId: context.consumerId, ownerRefs: ['fixture-owner'], profileIds: [profile.profile], limits, maxRunMs: 1000 },
  ]);
  const facade = createFacade({ kernel, usage, store, management, bearers, controlOnly: true, admission: new ServiceAdmission(),
    profiles: [{ dto: { profileId: profile.profile, protocol: 'openai-responses', modelIds: [profile.model], authKinds: ['api_key'] }, maxOutputTokens: 32 }],
    intentHmacKey: randomBytes(32), timeoutMs: 5000 });
  let blocker: pg.PoolClient | undefined;
  const requests: Promise<Response>[] = [];
  try {
    const state = (await admin.query("SELECT current_setting('server_version') AS version, NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')) AS empty")).rows[0];
    assert.match(state.version, /^17\.10(?:$| )/); assert.equal(state.empty, true);
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort())
      await admin.query(await readFile(new URL(file, directory), 'utf8'));
    await kernel.heartbeat(context, worker);
    await new Promise<void>(resolve => facade.listen(0, '127.0.0.1', resolve));
    const address = facade.address(); assert.ok(address && typeof address === 'object');
    const origin = 'http://127.0.0.1:' + address.port;
    const get = (path: string, credential = token) => fetch(origin + path, { headers: {
      authorization: 'Bearer ' + credential, accept: 'application/json', 'content-type': 'application/json', connection: 'close',
    }, signal: AbortSignal.timeout(8000) });
    const first = await get('/v1/usage?limit=1'); assert.equal(first.status, 200);
    const page = await first.json() as { nextCursor: string; highWaterCursor: string; observations: unknown[] };
    assert.deepEqual(page.observations, []);
    const paged = await get('/v1/usage?limit=1&afterCursor=' + page.nextCursor + '&highWaterCursor=' + page.highWaterCursor);
    assert.equal(paged.status, 200); await paged.body?.cancel();
    for (const [path, credential, expected] of [
      ['/v1/usage', run, 403], ['/v1/usage', 'fixture-invalid-credential', 401],
      ['/v1/usage?limit=1&limit=2', token, 400], ['/v1/usage?consumerId=other', token, 400],
      ['/v1/usage/' + randomUUID() + '/request', token, 200], ['/v1/usage/not-uuid/request', token, 400],
      ['/v1/usage?afterCursor=' + page.nextCursor, other, 403],
    ] as const) { const response = await get(path, credential); assert.equal(response.status, expected, path); await response.body?.cancel(); }
    blocker = await admin.connect(); await blocker.query('BEGIN'); await blocker.query('LOCK ag_kernel.usage_observations IN ACCESS EXCLUSIVE MODE');
    for (let i = 0; i < 8; i++) requests.push(get('/v1/usage?limit=1'));
    let blocked = 0;
    for (let i = 0; i < 60; i++) {
      blocked = Number((await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name='usage_capacity_data' AND wait_event_type='Lock' AND query LIKE 'SELECT position,fact%'")).rows[0].n);
      if (blocked === 6) break; await delay(20);
    }
    assert.equal(blocked, 6, 'analytics may occupy only six actual SQL clients');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([inServiceLane('control', () => Promise.all([kernel.heartbeat(context, worker), kernel.claimCleanup(context, worker)])),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reserved heartbeat/cleanup capacity unavailable')), 1500); })]);
    } finally { clearTimeout(timer); }
    assert.equal(pool.waitingCount, 0, 'data waiters stay outside the physical PostgreSQL pool');
    await blocker.query('ROLLBACK'); blocker.release(); blocker = undefined;
    for (const response of await Promise.all(requests)) { assert.equal(response.status, 200); await response.body?.cancel(); }
    await assert.rejects(usage.list(context, { afterCursor: 'invalid.cursor' }), { message: 'invalid' });
    const clients = await Promise.all(Array.from({ length: 6 }, () => sharedCheckout(pool)()));
    clients.forEach(client => client.release());
    assert.equal(pool.waitingCount, 0, 'cursor and query completion release every admission slot');
  } finally {
    if (blocker) { await blocker.query('ROLLBACK').catch(() => undefined); blocker.release(); }
    await Promise.allSettled(requests); facade.closeAllConnections();
    await new Promise<void>(resolve => facade.close(() => resolve()));
    await Promise.all([pool.end(), admin.end()]);
  }
});
