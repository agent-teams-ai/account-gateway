// Source-only checkpoint: PG NOT_RUN until exact source acceptance. This suite
// uses migrated disposable SQL and private HTTP, never a provider or native runtime.
// Regression: treating F3 prepared as invalid/staged quarantines ordinary waiting;
// replay after a lost ACK duplicates Begin; custody-only promotion exposes an
// unqualified account; lossy or substituted birth descriptors activate the wrong row.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as c from '@agent-teams/account-gateway/contracts';
import { createManagementClient, GatewayError } from '@agent-teams/account-gateway/http';
import { KernelError } from '../src/domain.ts';
import type { TrustedContext } from '../src/domain.ts';
import { PostgresKernel } from '../src/postgres.ts';
import { AccountManagement, codexOAuthProfile, sameCandidate } from '../src/management.ts';
import type { CandidateJournal, NativeReadback, OAuthBeginInput, OAuthDescriptor,
  OAuthDescriptorBoundary, OAuthReadback, OAuthScope, PhysicalCandidate } from '../src/management.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { NativeManagementClient, NativeOAuthEnrollmentClient, NativeOAuthLifecycleClient, NativeFailure } from '../src/native-client.ts';
import { createFacade, FacadeBearers } from '../src/facade.ts';
import type { ManagementBearer } from '../src/facade.ts';
import { captureOAuthEnrollmentConfig, ServiceError } from '../src/service-config.ts';
import { NativeAuthority } from '../src/native-authority.ts';

// Reuse management-postgres's disposable guard and migration procedure. Its
// helper is private to that suite; exporting it would widen the ten owned paths.
let pool: pg.Pool;
function disposable(): { dsn: string; database: string } {
  const dsn = process.env.AG_MANAGEMENT_TEST_DSN ?? process.env.AG_KERNEL_TEST_DSN,
    database = process.env.AG_MANAGEMENT_DISPOSABLE_DB ?? process.env.AG_KERNEL_DISPOSABLE_DB;
  if (!dsn || !database || !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
      process.env.AG_KERNEL_TEST_ALLOW !== 'disposable_pg17_10') {
    throw new Error('NOT_RUN: explicit new disposable PG17.10 fixture required');
  }
  let url: URL;
  try { url = new URL(dsn); } catch { throw new Error('NOT_RUN: invalid disposable designation'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + database || url.search || url.hash) {
    throw new Error('NOT_RUN: refusing remote or unspecified DB');
  }
  return { dsn, database };
}
before(async () => {
  const selected = disposable();
  // Session defaults also bound selector SQL and BEGIN/COMMIT/ROLLBACK, not just the blocker.
  const config = { connectionString: selected.dsn, max: 6, connectionTimeoutMillis: 5000,
    statement_timeout: 10_000, query_timeout: 12_000 } satisfies pg.PoolConfig;
  pool = new pg.Pool(config);
  pool.on('error', () => undefined);
  try {
    const version = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
    assert.equal(version.db, selected.database); assert.match(version.version, /^17\.10(?:$| )/);
    const schemas = (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')")).rowCount;
    if (schemas === 0) {
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()) {
        await pool.query(await readFile(new URL(file, directory), 'utf8'));
      }
    } else {
      assert.equal(schemas, 2, 'refuse partially migrated fixture; never overwrite a schema');
      // Root can reuse the explicitly designated compatible populated F fixture.
      // Each case allocates its own consumer; existing rows are never cleared.
      await pool.query(`SELECT a.active_generation,c.native_identity,j.qualification_ref,m.native_created_at,
        w.lease_until FROM ag_kernel.accounts a,ag_kernel.candidates c,ag_management.candidate_journal j,
        ag_management.physical_mappings m,ag_kernel.workers w LIMIT 0`);
    }
    const maximum = (await pool.query('SELECT coalesce(max(native_id),4000)::text AS maximum FROM ag_management.physical_mappings')).rows[0].maximum;
    nextNativeId = Math.max(4000, Number(maximum));
    assert.ok(Number.isSafeInteger(nextNativeId) && nextNativeId < Number.MAX_SAFE_INTEGER - 1000, 'finite fresh synthetic identity space');
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error('NOT_RUN: disposable PostgreSQL setup unavailable; vendor details withheld');
  }
});
after(async () => { await pool?.end(); });

const apiProfile = Object.freeze({ profile: 'synthetic-profile', baseURL: 'https://fixture.invalid/v1',
  model: 'fixture-model', qualificationRef: 'synthetic-only' });
const oauthProfile = Object.freeze({ ...codexOAuthProfile, qualificationRef: 'controlled-descriptor-only' });
const owner = 'workspace-fixture', control = 'synthetic-native-control';
const bounds = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const birth = '2026-10-03T04:05:06.123456789+00:00';
function authorizationURL(): string {
  // Synthetic temporary capability. No browser/callback/provider is contacted.
  return 'https://auth.openai.com/oauth/authorize?' + new URLSearchParams({
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', response_type: 'code',
    redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
    code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'b'.repeat(32),
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs',
  });
}
function input(): OAuthBeginInput {
  return { operationId: randomUUID(), ownerRef: owner, profile: oauthProfile.profile, displayName: 'Disposable OAuth' };
}
function sdkInput(command: OAuthBeginInput): c.OAuthBegin {
  return { operationId: command.operationId, ownerRef: command.ownerRef,
    profileId: command.profile, displayName: command.displayName };
}
interface ConnectWire {
  operation: string; owner_ref: string; account_ref: string; generation: string;
}
function wire(scope: OAuthScope): ConnectWire {
  return { operation: scope.operationId, owner_ref: scope.ownerRef,
    account_ref: scope.accountRef, generation: scope.generation };
}
function scope(j: CandidateJournal): OAuthScope {
  return { consumerId: j.consumerId, operationId: j.operationId, ownerRef: j.ownerRef,
    accountRef: j.accountRef, generation: j.generation };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
let nextNativeId = 4000;
type DescriptorMode = 'absent' | 'unavailable' | 'pending' | 'qualified';
interface FixtureOptions { lostACK?: boolean; descriptor?: DescriptorMode }
async function fixture(options: FixtureOptions = {}) {
  const context: TrustedContext = { consumerId: 'oauth-fixture-' + randomUUID() };
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32));
  const kernel = new PostgresKernel(pool), store = new PostgresManagementStore(pool, custody);
  const worker = randomUUID(); await kernel.heartbeat(context, worker);
  const rows = new Map<string, NativeReadback>(), nativeIntents = new Map<string, ConnectWire>();
  const requests: { path: string; input: ConnectWire }[] = [], observedJournals: CandidateJournal[] = [];
  const descriptorScopes: OAuthScope[] = [];
  const cleanupRequests: { action: string; generation: string }[] = [];
  const erased = new Set<string>();
  let cleanupClosure: 'closed' | 'unknown' = 'closed', loseEraseACK = false;
  let begins = 0, candidateCreates = 0, candidateReads = 0, activations = 0, unexpected = 0;
  let connectState: OAuthReadback['state'] = 'prepared';
  let descriptorMode: DescriptorMode = options.descriptor ?? 'absent';
  let descriptorPatch: Partial<PhysicalCandidate> = {}, descriptorIdentity: Partial<Pick<OAuthDescriptor, 'operationId' | 'accountRef'>> = {};
  let replyPatch: Record<string, unknown> = {}, beginPatch: Record<string, unknown> = {};
  let responseURL = authorizationURL(), fixtureFailure: unknown;
  let callbackOrigin = '';
  const refreshRequests: ConnectWire[] = [];
  const refreshModes = new Map<string, 'drop' | 'unknown' | 'idle'>();
  const callbackToken = 'synthetic-refresh-callback';
  let refreshBarrier: { generation: string; entered: ReturnType<typeof Promise.withResolvers<void>>;
    released: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const callback = (route: string, body: unknown, token = callbackToken) => fetch(callbackOrigin + '/private/native/v1/' + route,
    { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(4500) });
  let descriptorBarrier: { entered: ReturnType<typeof Promise.withResolvers<void>>;
    released: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const nativeServer = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, 'Bearer ' + (req.url === '/private/native/v1/oauth/connect/cleanup' ? 'synthetic-oauth-cleanup' : control));
      if (req.method === 'POST' && req.url === '/private/native/v1/oauth/refresh') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const submitted = JSON.parse(Buffer.concat(chunks).toString()) as ConnectWire;
        assert.deepEqual(Object.keys(submitted).sort(), ['account_ref','generation','operation','owner_ref']);
        refreshRequests.push(submitted);
        // A second transaction must acquire the real consumer lock NOWAIT.
        // This goes RED if the selector holds its transaction across native HTTP.
        const independent = await pool.connect();
        try {
          await independent.query('BEGIN');
          await independent.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE NOWAIT', [context.consumerId]);
          await independent.query('COMMIT');
        } finally { await independent.query('ROLLBACK'); independent.release(); }
        const reply = await callback('oauth-refresh-authority', { consumerId: context.consumerId,
          operationId: submitted.operation, accountRef: submitted.account_ref, generation: submitted.generation });
        assert.equal(reply.status, 200, 'committed active authority before refresh');
        assert.deepEqual(await reply.json(), { ok: true, ownerRef: submitted.owner_ref });
        const barrier = refreshBarrier;
        if (barrier?.generation === submitted.generation) { barrier.entered.resolve(); await barrier.released.promise; }
        const mode = refreshModes.get(submitted.generation) ?? 'idle';
        if (mode === 'drop') { req.socket.destroy(); return; }
        res.end(JSON.stringify({ operation: submitted.operation, account_ref: submitted.account_ref, state: mode })); return;
      }
      if (req.method === 'POST' && (req.url === '/private/native/v1/oauth/connect' ||
          req.url === '/private/native/v1/oauth/connect/read')) {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const submitted = JSON.parse(Buffer.concat(chunks).toString()) as ConnectWire;
        assert.deepEqual(Object.keys(submitted).sort(), ['account_ref', 'generation', 'operation', 'owner_ref']);
        assert.equal(submitted.owner_ref, owner);
        const isBegin = req.url === '/private/native/v1/oauth/connect';
        requests.push({ path: req.url, input: submitted });
        if (isBegin) {
          begins++;
          // A second store/SQL transaction must see the committed original birth
          // BEFORE native receives Begin; no test wrapper around journal().
          const committed = await new PostgresManagementStore(pool, custody).readJournal(context, submitted.operation);
          assert.ok(committed, 'journal persisted before native Begin');
          assert.deepEqual(wire(scope(committed)), submitted);
          observedJournals.push(committed);
          assert.equal(nativeIntents.has(submitted.operation), false, 'one native Begin per operation');
          nativeIntents.set(submitted.operation, submitted);
          rows.set(submitted.generation, { generation: submitted.generation, nativePhysicalIdentity: submitted.generation,
            nativeId: ++nextNativeId, createdAt: birth, state: 'inactive', ...codexOAuthProfile });
          if (options.lostACK) { req.socket.destroy(); return; }
        } else {
          assert.deepEqual(submitted, nativeIntents.get(submitted.operation), 'Read retains the entire original native intent');
        }
        // Actual F3 connect wire: prepared on Begin, entered on callback entry,
        // completed with custody outcome staged. Never state:"staged" here.
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ operation: submitted.operation, account_ref: submitted.account_ref, state: connectState,
          ...(connectState === 'completed' ? { outcome: 'staged' } : {}),
          ...(isBegin && connectState === 'prepared' ? { authorize_url: responseURL } : {}),
          ...(isBegin ? beginPatch : replyPatch) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/private/native/v1/oauth/connect/descriptor') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const submitted = JSON.parse(Buffer.concat(chunks).toString()) as ConnectWire;
        assert.deepEqual(submitted, nativeIntents.get(submitted.operation));
        const row = rows.get(submitted.generation); assert.ok(row);
        const d = { account_id: row.nativeId, generation: row.generation, created_at: row.createdAt,
          profile: row.profile, base_url: row.baseURL, model: row.model };
        // Producer wire retains native provenance and physical staged state.
        res.end(JSON.stringify({ operation: submitted.operation, account_ref: submitted.account_ref,
          state: 'staged', qualification: descriptorMode === 'qualified' ? 'controlled-source-v1' : 'pending',
          ...(descriptorMode === 'qualified' ? { native: d } : {}) })); return;
      }
      if (req.method === 'POST' && req.url === '/private/native/v1/oauth/connect/cleanup') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const submitted = JSON.parse(Buffer.concat(chunks).toString()) as ConnectWire & {
          action: 'read' | 'erase'; cleanup_ref: string; cleanup_token: string };
        cleanupRequests.push({ action: submitted.action, generation: submitted.generation });
        const owned = await callback('oauth-cleanup-authority', { consumerId: context.consumerId,
          operationId: submitted.operation, accountRef: submitted.account_ref, generation: submitted.generation,
          cleanupRef: submitted.cleanup_ref, cleanupToken: submitted.cleanup_token, action: submitted.action });
        if (owned.status !== 200) { res.statusCode = 403; res.end(); return; }
        const authority = await owned.json() as { ownerRef: string; leaseExpiresAt: string; native?: object };
        assert.equal(authority.ownerRef, submitted.owner_ref);
        assert.ok(Date.parse(authority.leaseExpiresAt) > Date.now());
        const row = rows.get(submitted.generation); assert.ok(row);
        const native = { account_id: row.nativeId, generation: row.generation, created_at: row.createdAt,
          profile: row.profile, base_url: row.baseURL, model: row.model };
        if (submitted.action === 'erase') {
          assert.deepEqual(authority.native, native, 'physical erasure requires committed bound exact birth');
          erased.add(submitted.generation);
          if (loseEraseACK) { loseEraseACK = false; req.socket.destroy(); return; }
        }
        res.end(JSON.stringify({ operation: submitted.operation, account_ref: submitted.account_ref,
          credentials_erased: erased.has(submitted.generation), closure: erased.has(submitted.generation) ? cleanupClosure : 'pending', native })); return;
      }
      if (req.url?.startsWith('/private/native/v1/candidates')) {
        if (req.method === 'GET') candidateReads++; else if (req.method === 'PUT') activations++; else candidateCreates++;
        res.statusCode = 403; res.end(); return;
      }
      unexpected++; res.statusCode = 404; res.end();
    })().catch(error => { fixtureFailure = error; res.destroy(); });
  });
  const nativeOrigin = await listen(nativeServer);
  const native = new NativeManagementClient({ origin: nativeOrigin, consumerId: context.consumerId, controlCredential: control });
  const oauth = new NativeOAuthEnrollmentClient({ origin: nativeOrigin, consumerId: context.consumerId,
    ownerRef: owner, controlCredential: control });
  // This single injected future protected boundary reads the SAME fixture rows.
  // It is not a second native client, SDK DTO, implemented endpoint or qualification.
  const descriptor: OAuthDescriptorBoundary = { async describe(s) {
    const captured = Object.freeze({ ...s }); descriptorScopes.push(captured);
    assert.equal(s.consumerId, context.consumerId);
    assert.deepEqual(wire(s), nativeIntents.get(s.operationId));
    if (descriptorBarrier) { descriptorBarrier.entered.resolve(); await descriptorBarrier.released.promise; }
    if (descriptorMode === 'unavailable') throw new NativeFailure('unavailable');
    const identity = { operationId: s.operationId, accountRef: s.accountRef, ...descriptorIdentity };
    const result = await oauth.describe(s);
    // Explicit source-boundary substitutions exercise the policy's independent checks.
    return result.state === 'qualified' ? { ...result, ...identity, native: { ...result.native, ...descriptorPatch } } : result;
  } };
  function manager(targetWorker = worker, withDescriptor = descriptorMode !== 'absent'): AccountManagement {
    return new AccountManagement({ kernel: new PostgresKernel(pool), store: new PostgresManagementStore(pool, custody),
      custody, native, worker: targetWorker, profiles: [apiProfile],
      proof: { async verify() { throw new Error('OAuth must not enter generic BYOK proof'); } }, oauth: { profile: oauthProfile, native: oauth, ...(withDescriptor ? { descriptor } : {}), lifecycle: new NativeOAuthLifecycleClient({ origin: nativeOrigin,
        consumerId: context.consumerId, ownerRef: owner, controlCredential: 'synthetic-oauth-cleanup' }) }, refresh: oauth });
  }
  let management = manager(), facade: Server | undefined;
  const token = 'synthetic-management-token', foreignToken = 'synthetic-foreign-owner';
  function grant(value: string, ownerRefs: readonly string[]): ManagementBearer {
    return { role: 'management', token: value, consumerId: context.consumerId, ownerRefs,
      preparation: { accountRefs: [], subjectRef: 'binding-fixture', policyRevision: 2, bindingRevision: 3,
        profileId: oauthProfile.profile, limits: bounds, maxRunMs: 60_000 } };
  }
  const bearers = new FacadeBearers([grant(token, [owner]), grant(foreignToken, ['foreign-owner'])]);
  const authority = new NativeAuthority({ kernel, store, oauthOwners: { store, bearers }, oauthRefreshOwners: { store, bearers }, oauthCleanupOwners: { store },
    config: { origin: nativeOrigin, enrollment: { originRef: 'synthetic-refresh-origin', engineIncarnation: randomUUID(),
      worker, qualificationRef: oauthProfile.qualificationRef }, consumers: [{ consumerId: context.consumerId,
      executionCredential: 'synthetic-refresh-execution', cleanupCredential: 'synthetic-refresh-cleanup', callbackCredential: callbackToken }],
      profiles: [{ ...oauthProfile, requestBytes: bounds.requestBytes, outputBytes: bounds.outputBytes,
        tokens: bounds.tokens, providerTokenUpperBound: 1000 }], timeoutMs: 5000 } });
  const callbackServer = authority.createServer(); callbackOrigin = await listen(callbackServer);
  async function startFacade(): Promise<string> {
    facade = createFacade({ kernel: new PostgresKernel(pool), management, store, bearers,
      profiles: [{ dto: { profileId: oauthProfile.profile, protocol: 'openai-responses',
        modelIds: [oauthProfile.model], authKinds: ['oauth'] }, maxOutputTokens: 1000 },
      { dto: { profileId: apiProfile.profile, protocol: 'openai-responses',
        modelIds: [apiProfile.model], authKinds: ['api_key'] }, maxOutputTokens: 1000 }],
      intentHmacKey: randomBytes(32) });
    return listen(facade);
  }
  let origin = await startFacade();
  const client = () => createManagementClient({ role: 'management', origin, token });
  return { context, kernel, store, worker, oauth, native, descriptorBoundary: descriptor, rows, requests, observedJournals, descriptorScopes,
    client, callback, bearers, grant: () => grant(token, [owner]), refreshRequests, refreshModes, cleanupRequests, erased,
    cleanupMode(closure: 'closed' | 'unknown', droppedACK = false) { cleanupClosure = closure; loseEraseACK = droppedACK; },
    foreign: () => createManagementClient({ role: 'management', origin, token: foreignToken }),
    management: () => management, manager, origin: () => origin,
    state(value: OAuthReadback['state']) { connectState = value; },
    descriptor(value: DescriptorMode, patch: Partial<PhysicalCandidate> = {}, identity: typeof descriptorIdentity = {}) {
      descriptorMode = value; descriptorPatch = patch; descriptorIdentity = identity;
    },
    replies(patch: Record<string, unknown>, begin = false) { if (begin) beginPatch = patch; else replyPatch = patch; },
    url(value: string) { responseURL = value; },
    holdDescriptor() {
      descriptorBarrier = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
      return { entered: descriptorBarrier.entered.promise, release: descriptorBarrier.released.resolve };
    },
    holdRefresh(generation: string) {
      refreshBarrier = { generation, entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
      const barrier = refreshBarrier;
      return { entered: barrier.entered.promise, release() { refreshBarrier = undefined; barrier.released.resolve(); } };
    },
    stats: () => ({ begins, candidateCreates, candidateReads, activations, unexpected }),
    async assertHealthy() { if (fixtureFailure) throw fixtureFailure; assert.equal(unexpected, 0); assert.equal(candidateCreates, 0); },
    async restart(targetWorker = worker, withDescriptor = descriptorMode !== 'absent') {
      if (facade) await stop(facade); management = manager(targetWorker, withDescriptor); origin = await startFacade();
    },
    async close() { descriptorBarrier?.released.resolve(); refreshBarrier?.released.resolve();
      if (facade) await stop(facade); await stop(callbackServer); await stop(nativeServer); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function journal(f: Fixture, command: OAuthBeginInput): Promise<CandidateJournal> {
  const j = await f.store.readJournal(f.context, command.operationId); assert.ok(j); return j;
}
async function assertPinned(f: Fixture, j: CandidateJournal): Promise<void> {
  assert.deepEqual(await f.store.readJournal(f.context, j.operationId), j);
  for (const request of f.requests) assert.deepEqual(request.input, wire(scope(j)));
  for (const s of f.descriptorScopes) assert.deepEqual(s, scope(j));
  assert.equal(f.stats().begins, 1); await f.assertHealthy();
}
async function assertInert(f: Fixture, j: CandidateJournal, expected: 'pending' | 'unknown' = 'pending'): Promise<void> {
  assert.equal((await f.kernel.operation(f.context, j.operationId)).state, expected);
  assert.equal((await f.kernel.account(f.context, j.accountRef)).state, expected === 'pending' ? 'staging' : 'quarantined');
  assert.equal(await f.store.mapping(f.context, j.generation), undefined);
  assert.equal(f.rows.get(j.generation)?.state, 'inactive'); assert.equal(f.stats().activations, 0);
  const saved = (await pool.query(`SELECT c.state,c.generation,a.active_generation FROM ag_kernel.candidates c
    JOIN ag_kernel.accounts a ON a.consumer=c.consumer AND a.ref=c.account_ref
    WHERE c.consumer=$1 AND c.operation_id=$2`, [f.context.consumerId, j.operationId])).rows[0];
  assert.equal(saved.generation, j.generation); assert.equal(saved.active_generation, null);
  assert.equal(saved.state, expected === 'pending' ? 'creating' : 'quarantined');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_management.transient_intents WHERE consumer=$1',
    [f.context.consumerId])).rows[0].n, 0, 'OAuth never stages credentials in TS SQL');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1',
    [f.context.consumerId])).rows[0].n, 0, 'management never obtains inference permission');
}
const code = (value: KernelError['code']) => (e: unknown): boolean => e instanceof KernelError && e.code === value;
const denied = (e: unknown): boolean => e instanceof GatewayError && e.code === 'safe_error' &&
  e.diagnostic?.code === 'forbidden';

async function activeOAuth(f: Fixture): Promise<CandidateJournal> {
  f.state('prepared');
  const command = input(); await f.client().beginOAuth(sdkInput(command));
  f.state('completed'); f.descriptor('qualified');
  assert.equal((await f.client().readOAuth(command.operationId)).state, 'applied');
  return journal(f, command);
}
function selectors(j: CandidateJournal): object {
  return { consumerId: j.consumerId, operationId: j.operationId, accountRef: j.accountRef, generation: j.generation };
}

// RED if cleanup needs a revoked management grant or guesses an unmapped birth,
// promotes a disabled candidate, retries erase after a lost ACK, or closes unknown.
test('F cleanup: current claim recovers unmapped custody and retains closure uncertainty', async t => {
  for (const mode of ['closed', 'lost_ack', 'unknown'] as const) await t.test(mode, async () => {
    const f = await fixture({ descriptor: 'qualified' }), command = input();
    try {
      await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
      f.state('completed');
      const account = await f.kernel.account(f.context, j.accountRef);
      await f.management().disable(f.context, { operationId: randomUUID(), accountRef: j.accountRef, expectedRevision: account.revision });
      assert.equal(await f.store.mapping(f.context, j.generation), undefined);
      const claim = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(claim?.scope.kind === 'generation');
      assert.equal(claim.scope.descriptor, undefined);
      f.bearers.replace([]); // Purpose cleanup survives revocation of connect grants.
      assert.equal((await f.callback('oauth-owner-authority', selectors(j))).status, 403);
      const body = { ...selectors(j), cleanupRef: claim.cleanupRef, cleanupToken: claim.token, action: 'read' };
      const valid = await f.callback('oauth-cleanup-authority', body);
      assert.equal(valid.status, 200);
      const receipt = await valid.json() as { ok: boolean; ownerRef: string; leaseExpiresAt: string; native?: unknown };
      assert.equal(receipt.ok, true); assert.equal(receipt.ownerRef, owner); assert.equal(receipt.native, undefined);
      assert.match(receipt.leaseExpiresAt, /\.\d{6}Z$/);
      for (const changed of [{ ...body, cleanupToken: randomUUID() }, { ...body, cleanupRef: randomUUID() },
        { ...body, generation: randomUUID() }, { ...body, operationId: randomUUID() },
        { ...body, consumerId: 'foreign' }, { ...body, ownerRef: owner }, { ...body, action: 'active' }]) {
        assert.equal((await f.callback('oauth-cleanup-authority', changed)).status, 403);
      }
      f.cleanupMode(mode === 'unknown' ? 'unknown' : 'closed', mode === 'lost_ack');
      const settled = await f.management().cleanupClaim(f.context, claim);
      assert.equal(settled, mode === 'unknown' ? 'quarantined' : 'erased');
      const mapping = await f.store.mapping(f.context, j.generation); assert.ok(mapping);
      assert.equal(sameCandidate(mapping.descriptor, f.rows.get(j.generation)!), true);
      assert.equal((await f.kernel.account(f.context, j.accountRef)).state, 'disabled');
      assert.equal((await f.kernel.operation(f.context, j.operationId)).state, 'unknown');
      const saved = (await pool.query(`SELECT c.native_identity,c.state,l.state AS cleanup_state FROM ag_kernel.candidates c
        JOIN ag_kernel.cleanup l ON l.consumer=c.consumer AND l.generation=c.generation WHERE c.consumer=$1 AND c.generation=$2`,
      [f.context.consumerId, j.generation])).rows[0];
      assert.equal(saved.native_identity, j.generation); assert.equal(saved.state, mode === 'unknown' ? 'quarantined' : 'retired');
      assert.equal(saved.cleanup_state, mode === 'unknown' ? 'pending' : 'done');
      assert.equal(f.cleanupRequests.filter(r => r.action === 'erase').length, 1);
      assert.equal(f.cleanupRequests.filter(r => r.action === 'read').length, mode === 'lost_ack' ? 2 : 1);
      assert.equal((await f.callback('oauth-cleanup-authority', body)).status, 403, 'settled claim is no longer authority');
      if (mode === 'unknown') {
        const next = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(next);
        assert.notEqual(next.token, claim.token);
        assert.equal(await f.management().cleanupClaim(f.context, next), 'quarantined');
        assert.equal(f.cleanupRequests.filter(r => r.action === 'erase').length, 1, 'erased unknown uses read-only recovery');
      }
      assert.deepEqual(f.stats(), { begins: 1, candidateCreates: 0, candidateReads: 0, activations: 0, unexpected: 0 });
      await f.assertHealthy();
    } finally { await f.close(); }
  });
});

// RED if immediate pending after unknown closure reclaims the smallest UUID
// forever. Existing last-claim lease orders progress without delaying recovery.
test('F cleanup fairness: unresolved low-ref birth yields to an independent job', async () => {
  const f = await fixture({ descriptor: 'qualified' });
  try {
    const journals: CandidateJournal[] = [];
    for (let n = 0; n < 2; n++) {
      f.state('prepared');
      const command = input(); await f.client().beginOAuth(sdkInput(command));
      const j = await journal(f, command); journals.push(j);
      f.state('completed');
      const account = await f.kernel.account(f.context, j.accountRef);
      await f.management().disable(f.context, { operationId: randomUUID(), accountRef: j.accountRef, expectedRevision: account.revision });
    }
    const [a, b] = journals;
    await pool.query(`UPDATE ag_kernel.cleanup SET ref=CASE WHEN generation=$2
      THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid END
      WHERE consumer=$1`, [f.context.consumerId, a.generation]);
    const first = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(first?.scope.kind === 'generation');
    assert.equal(first.scope.generation, a.generation);
    f.cleanupMode('unknown');
    assert.equal(await f.management().cleanupClaim(f.context, first), 'quarantined');
    const second = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(second?.scope.kind === 'generation');
    assert.equal(second.scope.generation, b.generation, 'unattempted independent cleanup progresses before pending unknown');
    f.cleanupMode('closed');
    assert.equal(await f.management().cleanupClaim(f.context, second), 'erased');
    const again = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(again?.scope.kind === 'generation');
    assert.equal(again.scope.generation, a.generation, 'unknown remains immediately eligible');
    assert.notEqual(again.token, first.token);
    f.cleanupMode('unknown');
    assert.equal(await f.management().cleanupClaim(f.context, again), 'quarantined');
    assert.equal((await f.kernel.operation(f.context, a.operationId)).state, 'unknown');
    assert.equal((await f.kernel.account(f.context, a.accountRef)).state, 'disabled');
    const saved = (await pool.query(`SELECT c.state,l.state AS cleanup_state FROM ag_kernel.candidates c
      JOIN ag_kernel.cleanup l ON l.consumer=c.consumer AND l.generation=c.generation WHERE c.consumer=$1 AND c.generation=$2`,
    [f.context.consumerId, a.generation])).rows[0];
    assert.equal(saved.state, 'quarantined'); assert.equal(saved.cleanup_state, 'pending');
    assert.equal(f.cleanupRequests.filter(r => r.generation === a.generation && r.action === 'erase').length, 1);
    await f.assertHealthy();
  } finally { await f.close(); }
});

// RED if a callback authorizes from an earlier lease read after waiting for SQL.
test('F cleanup authority rereads an expired claim after the consumer lock wait', async () => {
  const f = await fixture(), command = input(), gate = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    const account = await f.kernel.account(f.context, j.accountRef);
    await f.management().disable(f.context, { operationId: randomUUID(), accountRef: j.accountRef, expectedRevision: account.revision });
    const claim = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(claim);
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [f.context.consumerId]);
    pending = f.callback('oauth-cleanup-authority', { ...selectors(j), cleanupRef: claim.cleanupRef, cleanupToken: claim.token, action: 'erase' });
    await gate.query("UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2", [f.context.consumerId, claim.cleanupRef]);
    await gate.query('COMMIT');
    assert.equal((await pending).status, 403);
    assert.equal(f.cleanupRequests.length, 0); assert.equal(f.erased.size, 0);
  } finally { await gate.query('ROLLBACK'); gate.release(); await pending?.catch(() => undefined); await f.close(); }
});

// RED if lower-ref generation cleanup starves its execution closure, or nullable
// native proof is mistaken for transport absence at the saved execution generation.
test('F cleanup selection lets occupied execution close before generation erasure', async () => {
  const f = await fixture({ descriptor: 'qualified' });
  try {
    const j = await activeOAuth(f);
    const prepared = await f.kernel.prepare(f.context, { operationId: randomUUID(), intentDigest: 'cleanup-prerequisite',
      invocationRef: randomUUID(), attemptRef: 'one', permittedAccounts: [j.accountRef], profile: oauthProfile.profile,
      policySubject: 'cleanup-binding', policyRevision: 1, bindingRevision: 1, issuerEpoch: await f.kernel.issuer(f.context),
      deadline: new Date(Date.now() + 45_000), limits: bounds });
    assert.ok(prepared.executionRef);
    const saved = await f.kernel.savedExecution(f.context, prepared.executionRef);
    const claimed = await f.kernel.claim(f.context, prepared.executionRef, 'occupied', f.worker, saved.admission,
      { originRef: 'cleanup-fixture', engineIncarnation: randomUUID(), requestNonce: randomUUID() });
    assert.ok(claimed.dispatch);
    await f.kernel.effect(f.context, prepared.executionRef, 'occupied', f.worker, 'effect_unknown');
    const account = await f.kernel.account(f.context, j.accountRef);
    await f.management().disable(f.context, { operationId: randomUUID(), accountRef: j.accountRef, expectedRevision: account.revision });
    await pool.query(`UPDATE ag_kernel.cleanup SET ref=CASE WHEN generation IS NOT NULL
      THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid END WHERE consumer=$1`, [f.context.consumerId]);
    // A retained current claim still cannot erase once transport is occupied.
    const cleanupToken = randomUUID(), cleanupRef = '00000000-0000-4000-8000-000000000001';
    await pool.query(`UPDATE ag_kernel.cleanup SET state='claimed',worker=$2,token=$3,
      lease_until=clock_timestamp()+interval '10 seconds' WHERE consumer=$1 AND ref=$4`, [f.context.consumerId, f.worker, cleanupToken, cleanupRef]);
    const authority = { ...selectors(j), cleanupRef, cleanupToken, action: 'read' };
    assert.equal((await f.callback('oauth-cleanup-authority', authority)).status, 200);
    assert.equal((await f.callback('oauth-cleanup-authority', { ...authority, action: 'erase' })).status, 403);
    await pool.query("UPDATE ag_kernel.cleanup SET state='pending' WHERE consumer=$1 AND ref=$2", [f.context.consumerId, cleanupRef]);
    const execution = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(execution?.scope.kind === 'execution');
    assert.equal(execution.scope.executionRef, prepared.executionRef);
    assert.equal(await f.kernel.claimCleanup(f.context, f.worker), undefined, 'generation stays unclaimed while transport occupied');
    assert.equal(f.cleanupRequests.length, 0);
    await f.kernel.acknowledgeTransportClosed(f.context, f.worker, claimed.dispatch.closure,
      { cleanupRef: execution.cleanupRef, token: execution.token });
    await f.kernel.settleCleanup(f.context, execution.cleanupRef, f.worker, execution.token, true);
    const generation = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(generation?.scope.kind === 'generation');
    assert.equal(generation.scope.generation, j.generation);
    assert.equal(await f.management().cleanupClaim(f.context, generation), 'erased');
    assert.equal((await f.kernel.request(f.context, prepared.executionRef, 'occupied')).effect, 'effect_unknown');
    await f.assertHealthy();
  } finally { await f.close(); }
});

// RED if missing native fields on a retained legacy request imply no transport.
test('F cleanup selection preserves legacy unknown occupancy with no native proof', async () => {
  const f = await fixture({ descriptor: 'qualified' });
  try {
    const j = await activeOAuth(f);
    const prepared = await f.kernel.prepare(f.context, { operationId: randomUUID(), intentDigest: 'legacy-cleanup-prerequisite',
      invocationRef: randomUUID(), attemptRef: 'legacy-one', permittedAccounts: [j.accountRef], profile: oauthProfile.profile,
      policySubject: 'legacy-cleanup-binding', policyRevision: 1, bindingRevision: 1, issuerEpoch: await f.kernel.issuer(f.context),
      deadline: new Date(Date.now() + 45_000), limits: bounds });
    assert.ok(prepared.executionRef);
    await pool.query(`INSERT INTO ag_kernel.requests(consumer,execution_ref,id,effect,worker)
      VALUES ($1,$2,'legacy-unknown','effect_unknown',$3)`, [f.context.consumerId, prepared.executionRef, f.worker]);
    const account = await f.kernel.account(f.context, j.accountRef);
    await f.management().disable(f.context, { operationId: randomUUID(), accountRef: j.accountRef, expectedRevision: account.revision });
    const execution = await f.kernel.claimCleanup(f.context, f.worker); assert.ok(execution?.scope.kind === 'execution');
    assert.equal(execution.scope.transports.length, 1);
    assert.equal(execution.scope.transports[0].token, undefined); assert.equal(execution.scope.transports[0].native, undefined);
    assert.equal(await f.kernel.claimCleanup(f.context, f.worker), undefined);
    assert.equal(f.cleanupRequests.length, 0);
    assert.equal((await f.kernel.request(f.context, prepared.executionRef, 'legacy-unknown')).effect, 'effect_unknown');
  } finally { await f.close(); }
});

// RED if selection spans HTTP/callback with the consumer lock, if failed A is
// retried in the same tick, or if cursor advancement waits for a successful ACK.
// Native F2's durable no-second-entry proof belongs to its existing real PG case.
test('F refresh: committed real journal/HTTP selection advances past dropped ACK and unknown A to B', async () => {
  const f = await fixture({ descriptor: 'qualified' });
  try {
    const journals = [await activeOAuth(f), await activeOAuth(f)].sort((a, b) => a.generation.localeCompare(b.generation));
    const [a, b] = journals;
    const manager = f.manager();
    const accountBefore = await f.kernel.account(f.context, a.accountRef);
    const mappingBefore = await f.store.mapping(f.context, a.generation);
    const execution = await f.kernel.prepare(f.context, { operationId: randomUUID(), intentDigest: 'refresh-valid-use',
      invocationRef: 'refresh-use-' + randomUUID(), attemptRef: 'refresh-attempt', permittedAccounts: [a.accountRef],
      profile: oauthProfile.profile, policySubject: 'refresh-binding', policyRevision: 2, bindingRevision: 3,
      issuerEpoch: await f.kernel.issuer(f.context), deadline: new Date(Date.now() + 45_000), limits: bounds });
    assert.ok(execution.executionRef);
    const savedBefore = await f.kernel.savedExecution(f.context, execution.executionRef);
    const operationsBefore = (await pool.query('SELECT count(*)::int AS n FROM ag_kernel.operations WHERE consumer=$1',
      [f.context.consumerId])).rows[0].n;
    assert.equal(await manager.refreshOAuth(f.context, true), 'idle');
    assert.deepEqual(f.refreshRequests, [], 'an acquired cleanup claim suppresses even an eligible active refresh');
    f.refreshModes.set(a.generation, 'drop');
    const hold = f.holdRefresh(a.generation), pending = manager.refreshOAuth(f.context);
    try {
      await Promise.race([hold.entered, delay(3500).then(() => { throw new Error('refresh never reached real HTTP callback'); })]);
      assert.equal(await manager.refreshOAuth(f.context), 'idle', 'held request cannot overlap another selection');
      assert.deepEqual(f.refreshRequests, [wire(scope(a))]);
    } finally { hold.release(); }
    assert.equal(await pending, 'deferred');
    assert.deepEqual(f.refreshRequests, [wire(scope(a))], 'one HTTP, no immediate retry after dropped ACK');
    assert.equal(await manager.refreshOAuth(f.context), 'observed');
    assert.deepEqual(f.refreshRequests, [wire(scope(a)), wire(scope(b))]);
    f.refreshModes.set(a.generation, 'unknown');
    assert.equal(await manager.refreshOAuth(f.context), 'deferred');
    assert.equal(await manager.refreshOAuth(f.context), 'observed');
    assert.deepEqual(f.refreshRequests, [wire(scope(a)), wire(scope(b)), wire(scope(a)), wire(scope(b))]);
    // RED on 8261bb3: shutdown during selection still starts native HTTP after SQL unlocks.
    const gate = await pool.connect(), shutdown = new AbortController(), wait = new AbortController();
    const attemptsBefore = f.refreshRequests.length;
    let rawRefresh: ReturnType<AccountManagement['refreshOAuth']> | undefined;
    try {
      await f.kernel.heartbeat(f.context, f.worker);
      await gate.query('BEGIN');
      await gate.query("SET LOCAL statement_timeout='3500ms'");
      await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [f.context.consumerId]);
      const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      rawRefresh = manager.refreshOAuth(f.context, false, shutdown.signal);
      void rawRefresh.catch(() => undefined);
      const selecting = Promise.race([rawRefresh,
        delay(6500, undefined, { signal: wait.signal }).then(() => { throw new Error('shutdown refresh did not settle'); })]);
      void selecting.catch(() => undefined);
      const deadline = process.hrtime.bigint() + 2_500_000_000n; let blocked = false;
      while (!blocked && process.hrtime.bigint() < deadline) {
        await gate.query('SELECT pg_stat_clear_snapshot()');
        blocked = ((await gate.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount ?? 0) > 0;
        if (!blocked) await delay(10);
      }
      assert.equal(blocked, true, 'refresh selector reached the actual consumer SQL lock');
      assert.equal(f.refreshRequests.length, attemptsBefore, 'no native HTTP while SQL selection is blocked');
      shutdown.abort(); await gate.query('COMMIT');
      const result = await selecting;
      await gate.query('BEGIN');
      await gate.query("SET LOCAL statement_timeout='3500ms'");
      await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE NOWAIT', [f.context.consumerId]);
      await gate.query('COMMIT');
      assert.equal(f.refreshRequests.length, attemptsBefore, 'shutdown during selection must not start native HTTP');
      assert.equal(result, 'idle');
    } finally {
      shutdown.abort(); wait.abort();
      const rollback = { text: 'ROLLBACK', query_timeout: 3500 };
      let discard = false;
      try { await gate.query(rollback); }
      catch (error) { discard = true; throw error; }
      finally {
        // An uncertain transaction must never return to the pool; release before joining.
        try { gate.release(discard); }
        finally { await rawRefresh?.catch(() => undefined); }
      }
    }
    assert.deepEqual(await f.kernel.account(f.context, a.accountRef), accountBefore);
    assert.deepEqual(await f.kernel.savedExecution(f.context, execution.executionRef), savedBefore);
    assert.deepEqual(await f.store.readJournal(f.context, a.operationId), a);
    assert.deepEqual(await f.store.mapping(f.context, a.generation), mappingBefore);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.operations WHERE consumer=$1',
      [f.context.consumerId])).rows[0].n, operationsBefore, 'refresh creates no kernel operation');
    await f.assertHealthy();
  } finally { await f.close(); }
});

// RED if refresh reuses staging-capable connect authority, derives owner from
// the body, or accepts the original physical mapping after reconnect promotion.
test('F refresh authority: exact selectors require ACTIVE generation while connect retains staging', async () => {
  const f = await fixture({ descriptor: 'qualified' });
  try {
    const command = input(); await f.client().beginOAuth(sdkInput(command));
    const old = await journal(f, command);
    assert.equal((await f.callback('oauth-owner-authority', selectors(old))).status, 200);
    assert.equal((await f.callback('oauth-refresh-authority', selectors(old))).status, 403);
    f.state('completed'); assert.equal((await f.client().readOAuth(command.operationId)).state, 'applied');
    const accepted = await f.callback('oauth-refresh-authority', selectors(old));
    assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { ok: true, ownerRef: owner });
    for (const changed of [{ ...selectors(old), ownerRef: owner }, { ...selectors(old), operationId: randomUUID() },
      { ...selectors(old), generation: randomUUID() }, { ...selectors(old), accountRef: randomUUID() },
      { ...selectors(old), consumerId: 'foreign-consumer' }]) {
      const response = await f.callback('oauth-refresh-authority', changed);
      assert.equal(response.status, 403); assert.deepEqual(await response.json(), { code: 'denied' });
    }
    assert.equal((await f.callback('oauth-refresh-authority?alias=1', selectors(old))).status, 403);
    const current = await f.kernel.account(f.context, old.accountRef), operationId = randomUUID();
    await f.kernel.beginAccount(f.context, { kind: 'reconnect', operationId, accountRef: old.accountRef,
      expectedRevision: current.revision, intentDigest: 'controlled-refresh-reconnect' });
    const permit = await f.kernel.startCandidate(f.context, operationId, f.worker); assert.ok(permit); assert.ok(permit.candidate);
    const replacement = await f.store.journal({ consumerId: f.context.consumerId, operationId,
      accountRef: old.accountRef, ownerRef: owner, purpose: 'reconnect' }, permit.candidate, f.worker, oauthProfile);
    const descriptor = { ...codexOAuthProfile, generation: replacement.generation, nativePhysicalIdentity: replacement.generation,
      nativeId: ++nextNativeId, createdAt: birth };
    await f.store.saveMapping({ ...replacement, descriptor });
    assert.equal((await f.kernel.acknowledgeCandidate(f.context, operationId, f.worker, descriptor)).state, 'applied');
    assert.ok(await f.store.mapping(f.context, old.generation), 'old physical evidence remains present');
    assert.equal((await f.callback('oauth-refresh-authority', selectors(old))).status, 403);
    assert.equal((await f.callback('oauth-refresh-authority', selectors(replacement))).status, 200);
    f.bearers.replace([]);
    assert.equal((await f.callback('oauth-refresh-authority', selectors(replacement))).status, 403);
    f.bearers.replace([f.grant()]);
    assert.equal((await f.callback('oauth-refresh-authority', selectors(replacement))).status, 200);
    await pool.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
      [f.context.consumerId, f.worker]);
    assert.equal((await f.callback('oauth-refresh-authority', selectors(replacement))).status, 403);
    assert.equal(await f.store.nextOAuthRefresh(f.context, f.worker, oauthProfile), undefined);
  } finally { await f.close(); }
});

// RED if the management grant is captured before SQL: replace it while a real
// callback waits on the consumer lock, then observe denial over authenticated HTTP.
test('F refresh authority: grant replacement during real SQL wait denies the callback', async () => {
  const f = await fixture({ descriptor: 'qualified' }), gate = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    const j = await activeOAuth(f);
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [f.context.consumerId]);
    const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    pending = f.callback('oauth-refresh-authority', selectors(j)); void pending.catch(() => undefined);
    const deadline = Date.now() + 2500; let blocked = false;
    while (!blocked && Date.now() < deadline) {
      await gate.query('SELECT pg_stat_clear_snapshot()');
      blocked = ((await gate.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount ?? 0) > 0;
      if (!blocked) await delay(10);
    }
    assert.equal(blocked, true, 'callback reached actual SQL lock');
    f.bearers.replace([]); await gate.query('COMMIT');
    assert.equal((await pending).status, 403);
  } finally {
    await gate.query('ROLLBACK'); gate.release(); await pending?.catch(() => undefined); await f.close();
  }
});

// Regression: invented staged DTO/URL restriction changes a real prepared Begin
// into unknown; ordinary waiting/completed custody must stay inert through GET.
test('F source: prepared Begin journals first; prepared/entered/completed without descriptor remain pending', async () => {
  const f = await fixture(), command = input();
  try {
    const begun = await f.client().beginOAuth(sdkInput(command));
    assert.deepEqual(begun.operation, { operationRef: command.operationId, state: 'pending' });
    assert.equal(begun.authorizationURL === authorizationURL(), true, 'only fresh Begin receives the capability');
    const j = await journal(f, command); assert.deepEqual(f.observedJournals, [j]);
    for (const state of ['prepared', 'entered', 'completed'] as const) {
      f.state(state);
      assert.deepEqual(await f.client().readOAuth(command.operationId), begun.operation);
      assert.deepEqual(await f.client().beginOAuth(sdkInput(command)), { operation: begun.operation });
      const account = await f.client().get(j.accountRef);
      assert.equal(account.state, 'staging');
      assert.deepEqual(Object.keys(account).sort(), ['accountRef', 'authorizationEpoch', 'displayName',
        'metadataRevision', 'ownerRef', 'profileId', 'state']);
      await assertInert(f, j); await assertPinned(f, j);
    }
    assert.equal(f.descriptorScopes.length, 0); assert.equal(f.stats().candidateReads, 0);
    assert.equal(await f.store.credential(j), undefined);
  } finally { await f.close(); }
});

// Regression: a lost native response re-enters Begin or reconstructs its URL on
// duplicate POST/restart; an invalid ACK is equally ambiguous and Read-only.
test('F source: lost and invalid Begin ACK use Read on the original journal through restart', async t => {
  for (const mode of ['lost', 'invalid'] as const) await t.test(mode, async () => {
    const f = await fixture({ lostACK: mode === 'lost' }), command = input();
    try {
      if (mode === 'invalid') f.replies({ operation: 'foreign-operation' }, true);
      const begun = await f.client().beginOAuth(sdkInput(command));
      assert.deepEqual(begun, { operation: { operationRef: command.operationId, state: 'pending' } });
      const j = await journal(f, command); assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1].path, '/private/native/v1/oauth/connect/read');
      await f.restart();
      assert.deepEqual(await f.client().beginOAuth(sdkInput(command)), begun);
      assert.deepEqual(await f.client().operation(command.operationId), begun.operation);
      await assertInert(f, j); await assertPinned(f, j);
    } finally { await f.close(); }
  });
});

// Regression: racing same-intent callers each spend a native Begin or each
// receive a persisted capability, rather than sharing the one durable candidate.
test('F source: concurrent stable Begin callers share one journal and one capability', async () => {
  const f = await fixture(), command = input();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => f.client().beginOAuth(sdkInput(command))));
    for (const result of results) assert.deepEqual(result.operation, { operationRef: command.operationId, state: 'pending' });
    assert.equal(results.filter(result => result.authorizationURL !== undefined).length, 1);
    const j = await journal(f, command); assert.deepEqual(f.observedJournals, [j]);
    await assertInert(f, j); await assertPinned(f, j);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.candidates WHERE consumer=$1',
      [f.context.consumerId])).rows[0].n, 1);
  } finally { await f.close(); }
});

// Regression: calling accounts/check during user interaction, or promoting a
// custody-only completed row, bypasses the future protected descriptor gate.
test('F source: waiting ignores even a qualified injection; pending/missing descriptor cannot promote completed custody', async t => {
  for (const mode of ['pending', 'unavailable', 'qualified'] as const) await t.test(mode, async () => {
    const f = await fixture({ descriptor: mode }), command = input();
    try {
      await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
      f.state('entered'); assert.equal((await f.client().readOAuth(command.operationId)).state, 'pending');
      assert.equal(f.descriptorScopes.length, 0, 'prepared/entered are legitimate waiting states');
      f.descriptor(mode === 'qualified' ? 'pending' : mode); f.state('completed');
      assert.equal((await f.client().readOAuth(command.operationId)).state, 'pending');
      assert.equal(f.descriptorScopes.length, 1); assert.equal(f.stats().candidateReads, 0);
      await assertInert(f, j); await assertPinned(f, j);
    } finally { await f.close(); }
  });
});

// Red if metadata rename rejects an already-effected initial birth, overwrites
// the latest name, rotates authority, or bypasses exact qualified inactive proof.
test('F source: staging rename preserves original qualified birth and epoch while retaining latest metadata', async () => {
  const f = await fixture({ descriptor: 'pending' }), command = input();
  try {
    await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    const original = await f.kernel.account(f.context, j.accountRef);
    const renamed = await f.management().rename(f.context, { operationId: randomUUID(), accountRef: j.accountRef,
      expectedRevision: original.revision, displayName: 'Latest staging name' });
    assert.equal(renamed.state, 'applied'); assert.equal(renamed.epoch, original.epoch);
    f.state('completed'); assert.equal((await f.client().readOAuth(command.operationId)).state, 'pending');
    await assertInert(f, j);
    f.descriptor('qualified');
    const applied = await f.client().readOAuth(command.operationId);
    assert.ok(applied.state === 'applied' && applied.result?.kind === 'account');
    assert.equal(applied.result.accountRef, j.accountRef);
    assert.equal(applied.result.authorizationEpoch, original.epoch);
    assert.equal(applied.result.metadataRevision, renamed.revision! + 1);
    const mapping = await f.store.mapping(f.context, j.generation); assert.ok(mapping);
    assert.equal(mapping.descriptor.createdAt, birth); assert.equal(mapping.descriptor.nativePhysicalIdentity, j.generation);
    assert.equal(mapping.descriptor.nativeId, f.rows.get(j.generation)?.nativeId);
    assert.equal(f.stats().candidateReads, 0);
    assert.equal(f.rows.get(j.generation)?.state, 'inactive', 'logical ACK never activates physical OAuth');
    const saved = (await pool.query('SELECT active_generation FROM ag_kernel.accounts WHERE consumer=$1 AND ref=$2',
      [f.context.consumerId, j.accountRef])).rows[0];
    assert.equal(saved.active_generation, j.generation);
    const account = await f.client().get(j.accountRef);
    assert.equal(account.state, 'active'); assert.equal(account.displayName, 'Latest staging name');
    assert.equal(account.authorizationEpoch, original.epoch);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.cleanup WHERE consumer=$1',
      [f.context.consumerId])).rows[0].n, 0, 'harmless staging rename must not schedule birth cleanup');
    await f.restart();
    const before = f.stats();
    assert.deepEqual(await f.client().readOAuth(command.operationId), applied);
    assert.deepEqual(await f.client().beginOAuth(sdkInput(command)), { operation: applied });
    assert.deepEqual(f.stats(), before, 'applied readback cannot activate or Begin again');
    await assertPinned(f, j);
  } finally { await f.close(); }
});

// Red if final ACK overwrites a committed disable's unknown with rejected,
// promotes through its epoch/state fence, or loses exact physical cleanup proof.
test('F source: disable wins final native ACK atomically without erasing effected classification', async () => {
  const f = await fixture({ descriptor: 'qualified' }), command = input(), pending: Promise<unknown>[] = [];
  const gate = await pool.connect();
  try {
    await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    f.state('completed'); assert.equal((await f.oauth.read(scope(j))).state, 'completed');
    const qualified = await f.descriptorBoundary.describe(scope(j)); assert.equal(qualified.state, 'qualified');
    assert.ok(qualified.state === 'qualified');
    const inactive = f.rows.get(j.generation); assert.ok(inactive);
    assert.equal(inactive.state, 'inactive'); assert.equal(sameCandidate(inactive, qualified.native), true);
    const mapping = { ...j, descriptor: qualified.native }; await f.store.saveMapping(mapping);
    const original = await f.kernel.account(f.context, j.accountRef);
    assert.equal((await f.kernel.operation(f.context, command.operationId)).state, 'pending');
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [f.context.consumerId]);
    const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    async function blockedBy(pid: number): Promise<number> {
      const until = process.hrtime.bigint() + 5_000_000_000n;
      while (process.hrtime.bigint() < until) {
        await gate.query('SELECT pg_stat_clear_snapshot()');
        const blocked = (await gate.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [pid])).rows[0];
        if (blocked) return blocked.pid as number;
        await delay(10);
      }
      throw new Error('final ACK fixture did not reach the real SQL lock boundary');
    }
    const disable = f.management().disable(f.context, { operationId: randomUUID(), accountRef: j.accountRef,
      expectedRevision: original.revision }); pending.push(disable); void disable.catch(() => undefined);
    const disablePid = await blockedBy(gatePid);
    const proof = { generation: inactive.generation, nativePhysicalIdentity: inactive.nativePhysicalIdentity, profile: inactive.profile };
    const ack = f.kernel.acknowledgeCandidate(f.context, command.operationId, f.worker, proof);
    pending.push(ack); void ack.catch(() => undefined);
    assert.notEqual(await blockedBy(disablePid), disablePid, 'ACK waits behind the actual disable transaction');
    await gate.query('COMMIT');
    assert.equal((await disable).state, 'applied');
    const result = await ack; assert.equal(result.state, 'unknown'); assert.equal(result.code, 'account_disabled');
    const visible = await f.client().readOAuth(command.operationId);
    assert.ok(visible.state === 'unknown' && visible.error?.effect === 'effect_unknown');
    const account = await f.kernel.account(f.context, j.accountRef);
    assert.equal(account.state, 'disabled'); assert.equal(account.epoch, original.epoch + 1);
    const saved = (await pool.query(`SELECT a.active_generation,c.state,c.native_identity FROM ag_kernel.accounts a
      JOIN ag_kernel.candidates c ON c.consumer=a.consumer AND c.account_ref=a.ref
      WHERE a.consumer=$1 AND a.ref=$2 AND c.generation=$3`, [f.context.consumerId, j.accountRef, j.generation])).rows[0];
    assert.equal(saved.active_generation, null); assert.equal(saved.state, 'quarantined');
    assert.equal(saved.native_identity, proof.nativePhysicalIdentity);
    const cleanup = await f.kernel.claimCleanup(f.context, f.worker);
    assert.ok(cleanup?.scope.kind === 'generation'); assert.equal(cleanup.scope.generation, j.generation);
    assert.deepEqual(cleanup.scope.descriptor, proof);
    assert.deepEqual(await f.kernel.acknowledgeCandidate(f.context, command.operationId, f.worker, proof), result);
    await assert.rejects(f.kernel.acknowledgeCandidate(f.context, command.operationId, f.worker,
      { ...proof, nativePhysicalIdentity: randomUUID() }), code('conflict'));
    assert.equal(await f.kernel.startCandidate(f.context, command.operationId, f.worker), undefined);
    assert.equal((await f.client().beginOAuth(sdkInput(command))).operation.state, 'unknown');
    assert.equal(f.stats().activations, 0);
    await assertPinned(f, j);
  } finally { await gate.query('ROLLBACK'); gate.release(); await Promise.allSettled(pending); await f.close(); }
});

// Regression: a profile/model/origin/birth/account substitution still saves a
// mapping or calls setState(active). Precision mismatches must compare text.
test('F source: every protected descriptor substitution denies before mapping or activation', async t => {
  const variants: { name: string; physical?: Partial<PhysicalCandidate>;
    identity?: Partial<Pick<OAuthDescriptor, 'operationId' | 'accountRef'>> }[] = [
    { name: 'profile', physical: { profile: apiProfile.profile } },
    { name: 'model alias', physical: { model: 'gpt-6.1' } },
    { name: 'provider base', physical: { baseURL: 'https://fixture.invalid/v1' } },
    { name: 'generation', physical: { generation: randomUUID() } },
    { name: 'physical generation', physical: { nativePhysicalIdentity: randomUUID() } },
    { name: 'numeric identity', physical: { nativeId: 1 } },
    { name: 'nanosecond birth', physical: { createdAt: '2026-10-03T04:05:06.123456788+00:00' } },
    { name: 'truncated birth', physical: { createdAt: '2026-10-03T04:05:06.123+00:00' } },
    { name: 'operation', identity: { operationId: randomUUID() } },
    { name: 'account', identity: { accountRef: randomUUID() } },
  ];
  for (const variant of variants) await t.test(variant.name, async () => {
    const f = await fixture({ descriptor: 'qualified' }), command = input();
    try {
      await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
      f.descriptor('qualified', variant.physical, variant.identity); f.state('completed');
      const result = await f.client().readOAuth(command.operationId);
      assert.equal(result.state, 'unknown');
      assert.ok(result.state === 'unknown' && result.error?.effect === 'effect_unknown');
      await assertInert(f, j, 'unknown');
      assert.equal((await f.client().beginOAuth(sdkInput(command))).operation.state, 'unknown');
      await assertPinned(f, j);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.cleanup WHERE consumer=$1 AND generation=$2',
        [f.context.consumerId, j.generation])).rows[0].n, 1, 'retain original cleanup evidence');
    } finally { await f.close(); }
  });
});

// Regression: expiry/unknown or unexpected failed/rejected wire is treated as
// not_dispatched and re-arms the same operation. No status is a no-effect proof.
test('F source: ambiguous or expired connect readback quarantines without recreating or erasing effects', async t => {
  for (const state of ['expired', 'unknown', 'staged', 'failed', 'rejected']) await t.test(state, async () => {
    const f = await fixture(), command = input();
    try {
      await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
      f.replies({ state });
      const unknown = await f.client().readOAuth(command.operationId);
      assert.ok(unknown.state === 'unknown' && unknown.error?.effect === 'effect_unknown');
      assert.equal(unknown.error.retry.kind, 'readback');
      await assertInert(f, j, 'unknown'); await f.restart();
      assert.equal((await f.client().beginOAuth(sdkInput(command))).operation.state, 'unknown');
      await assertPinned(f, j);
    } finally { await f.close(); }
  });
});

// Regression: readback allows URL/state export, accepts a foreign operation or
// account, or conflates custody outcome staged with actual connect state.
test('F source: native read rejects URL and correlation changes; completed discards custody outcome', async t => {
  for (const variant of [{ authorize_url: authorizationURL() }, { operation: randomUUID() },
    { account_ref: randomUUID() }, { token: 'synthetic-forbidden' }]) {
    await t.test(Object.keys(variant)[0], async () => {
      const f = await fixture(), command = input();
      try {
        await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
        f.replies(variant);
        await assert.rejects(f.oauth.read(scope(j)), (e: unknown) => e instanceof NativeFailure && e.code === 'invalid_readback');
        assert.equal((await f.client().readOAuth(command.operationId)).state, 'unknown');
        await assertInert(f, j, 'unknown'); await assertPinned(f, j);
      } finally { await f.close(); }
    });
  }
  await t.test('completed custody outcome', async () => {
    const f = await fixture(), command = input();
    try {
      await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command); f.state('completed');
      assert.deepEqual(await f.oauth.read(scope(j)), { operationId: command.operationId, accountRef: j.accountRef, state: 'completed' });
      await assertInert(f, j); await assertPinned(f, j);
    } finally { await f.close(); }
  });
});

// Regression: caller chooses a native owner/consumer or mutates the stable
// intent; owner authorization must deny before native contact or new SQL rows.
test('F source: cross-owner/consumer and changed stable intent reject without native Begin', async () => {
  const f = await fixture(), command = input();
  try {
    await assert.rejects(f.foreign().beginOAuth(sdkInput(command)), denied);
    assert.equal(f.stats().begins, 0);
    await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    const before = f.requests.length;
    await assert.rejects(f.foreign().readOAuth(command.operationId), denied);
    await assert.rejects(f.foreign().get(j.accountRef), denied);
    for (const changed of [{ displayName: 'Changed' }, { ownerRef: 'foreign-owner' }, { profile: apiProfile.profile }]) {
      await assert.rejects(f.management().beginOAuth(f.context, { ...command, ...changed }),
        code('profile' in changed ? 'denied' : 'conflict'));
    }
    for (const changed of [{ ownerRef: 'foreign-owner' }, { consumerId: 'foreign-consumer' }]) {
      await assert.rejects(f.oauth.read({ ...scope(j), ...changed }),
        (e: unknown) => e instanceof NativeFailure && e.code === 'denied');
    }
    assert.equal(f.requests.length, before); await assertInert(f, j); await assertPinned(f, j);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.accounts WHERE consumer=$1',
      [f.context.consumerId])).rows[0].n, 1);
  } finally { await f.close(); }
});

// Regression: replacement workers reacquire a spent permit, revive a candidate
// after lease loss, or silently activate while SQL has quarantined authority.
test('F source: live owner restart waits; lease loss retains unknown and exact cleanup without promotion', async () => {
  const f = await fixture({ descriptor: 'qualified' }), command = input();
  try {
    await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    const replacement = randomUUID(); await f.kernel.heartbeat(f.context, replacement);
    await f.restart(replacement); const before = f.requests.length;
    assert.equal((await f.client().readOAuth(command.operationId)).state, 'pending');
    assert.equal(f.requests.length, before, 'a replacement worker cannot take over the live owner');
    await pool.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
      [f.context.consumerId, f.worker]);
    f.state('completed');
    const lost = await f.client().readOAuth(command.operationId);
    assert.ok(lost.state === 'unknown' && lost.error?.effect === 'effect_unknown');
    assert.equal((await f.client().get(j.accountRef)).state, 'quarantined');
    assert.equal(f.stats().activations, 0); assert.equal(f.rows.get(j.generation)?.state, 'inactive');
    assert.equal(await f.store.mapping(f.context, j.generation), undefined);
    assert.equal(f.descriptorScopes.length, 0, 'qualification cannot revive lost owner authority');
    const job = await f.kernel.claimCleanup(f.context, replacement);
    assert.ok(job && job.scope.kind === 'generation'); assert.equal(job.scope.generation, j.generation);
    assert.equal(job.scope.descriptor, undefined, 'cleanup cannot infer a native identity from custody');
    assert.equal((await f.client().beginOAuth(sdkInput(command))).operation.state, 'unknown');
    await assertPinned(f, j);
  } finally { await f.close(); }
});

// Regression: delayed protected qualification resumes promotion using the
// pre-await pending snapshot after its worker lease has already expired.
test('F source: owner loss while descriptor is held preserves unknown with zero physical activation', async () => {
  const f = await fixture({ descriptor: 'qualified' }), command = input();
  let read: Promise<c.Operation> | undefined;
  const barrier = f.holdDescriptor();
  try {
    await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    f.state('completed'); read = f.client().readOAuth(command.operationId); void read.catch(() => undefined);
    await barrier.entered;
    await pool.query("UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
      [f.context.consumerId, f.worker]);
    barrier.release();
    const result = await read;
    assert.ok(result.state === 'unknown' && result.error?.effect === 'effect_unknown');
    assert.equal((await f.kernel.account(f.context, j.accountRef)).state, 'quarantined');
    const savedMapping = await f.store.mapping(f.context, j.generation); assert.ok(savedMapping);
    assert.equal(savedMapping.descriptor.nativeId, f.rows.get(j.generation)?.nativeId, 'late birth proof remains available for leased cleanup');
    await assertPinned(f, j);
    assert.equal(f.stats().candidateReads, 0, 'OAuth does not use generic candidate routes');
  } finally { barrier.release(); await read?.catch(() => undefined); await f.close(); }
});

// Regression: PKCE callback/origin aliases or inherited object names become
// capabilities; invalid ACK must Read, never follow redirects/recreate Begin.
test('F source: invalid authorization authorities and query fields lose URL and preserve one pending Begin', async t => {
  const valid = authorizationURL();
  const variants = [valid.replace('auth.openai.com', 'auth.openai.com.evil.invalid'),
    valid.replace('/oauth/authorize?', '/oauth/authorize/../authorize?'),
    valid + '#fragment', valid + '&client_id=other', valid + '&constructor=value',
    valid.replace('client_id=', '%63lient_id='), valid.replace('client_id=', 'Client_id='),
    valid.replace('localhost%3A1455', '127.0.0.1%3A1455'),
    valid.replace('code_challenge_method=S256', 'code_challenge_method=plain'), valid + '&access_token=synthetic',
    valid.replace('https://', 'https://userinfo@'), valid + '&state=' + 'b'.repeat(32)];
  for (const [n, value] of variants.entries()) await t.test(String(n), async () => {
    const f = await fixture(), command = input();
    try {
      f.url(value);
      const result = await f.client().beginOAuth(sdkInput(command));
      assert.deepEqual(result, { operation: { operationRef: command.operationId, state: 'pending' } });
      const j = await journal(f, command); await assertInert(f, j); await assertPinned(f, j);
      assert.equal(f.requests.length, 2, 'invalid ACK has one bounded native Read');
    } finally { await f.close(); }
  });
});

// Regression: a config alias or caller endpoint silently enables product OAuth;
// SDK input stays additive and existing raw OAuth ingress remains unsupported.
test('F source: fixed opt-in catalog and strict PKCE ingress cannot enable raw OAuth or dispatch', async () => {
  const f = await fixture(), command = input();
  try {
    const cfg = captureOAuthEnrollmentConfig({ enabled: true, profile: oauthProfile.profile, modelScope: ['gpt-6.1-sol'] });
    assert.deepEqual(cfg.modelScope, ['gpt-6.1-sol']); assert.equal(Object.isFrozen(cfg.modelScope), true);
    for (const extra of [{ modelScope: ['gpt-6.1'] }, { modelScope: ['gpt-6.1-sol', 'gpt-6.1'] },
      { baseURL: 'https://fixture.invalid' }, { enabled: false }, { modelScope: [] }]) {
      assert.throws(() => captureOAuthEnrollmentConfig({ ...cfg, ...extra }),
        (e: unknown) => e instanceof ServiceError && e.code === 'config_denied');
    }
    const catalog = await f.client().profiles();
    assert.deepEqual(catalog.profiles.find(p => p.profileId === oauthProfile.profile), {
      profileId: oauthProfile.profile, protocol: 'openai-responses', modelIds: ['gpt-6.1-sol'], authKinds: ['oauth'],
    });
    for (const extra of [{ model: 'other' }, { callback: 'https://fixture.invalid' },
      { accessToken: 'synthetic' }, { verifier: 'synthetic' }, { origin: 'https://fixture.invalid' }]) {
      assert.throws(() => f.client().beginOAuth({ ...sdkInput(command), ...extra }),
        (e: unknown) => e instanceof GatewayError && e.code === 'invalid_input');
    }
    await assert.rejects(f.client().connect({ operationId: command.operationId, ownerRef: owner,
      profileId: oauthProfile.profile, displayName: command.displayName, credential: {
        kind: 'oauth', accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: '2026-12-01T00:00:00Z',
      } }), denied);
    assert.equal(f.stats().begins, 0);
    const begun = await f.client().beginOAuth(sdkInput(command)); const j = await journal(f, command);
    assert.equal(c.operation.safeParse({ ...begun.operation, authorizationURL: authorizationURL() }).success, false);
    await assert.rejects(f.client().prepare({ operationId: randomUUID(), invocationRef: 'fixture', attemptRef: 'one',
      accountRefs: [j.accountRef], profileId: oauthProfile.profile, subjectRef: 'binding-fixture',
      policyRevision: 2, bindingRevision: 3, limits: bounds, deadline: new Date(Date.now() + 30_000).toISOString() }), denied);
    await assertInert(f, j); await assertPinned(f, j);
  } finally { await f.close(); }
});
