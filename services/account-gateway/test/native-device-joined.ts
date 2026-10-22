// Explicit controlled joint E2E: real public SDK/facade/management/native client,
// real Go native HTTP/service/repository/custody/descriptor and two fresh PG17 DBs.
// The Go fixture owns a local TLS OpenAI-shaped provider; no live account access.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import pg from 'pg';
import { createManagementClient, GatewayError } from '@agent-teams/account-gateway/http';
import { PostgresKernel } from '../src/postgres.ts';
import { IntentSecrets, PostgresManagementStore } from '../src/management-store.ts';
import { codexOAuthProfile } from '../src/management.ts';
import { composeServiceControl, composeServiceNative } from '../src/service.ts';
import { createFacade } from '../src/facade.ts';
import type { ServiceConfig } from '../src/service-config.ts';

const report = (value: object): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
let phase = 'guard';
const servers: Server[] = [];
let pool: pg.Pool | undefined;
let child: ReturnType<typeof spawn> | undefined;
let stopped = false;
let childExit: Promise<number | null> | undefined;
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
async function bounded<T>(work: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('controlled joined timeout')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
function disposable(name: string, prefix: string): string {
  const raw = process.env[name]; assert.ok(raw);
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.ok(url.port && url.port !== '5432');
  assert.equal(url.username, 'postgres'); assert.equal(url.password, '');
  assert.equal(url.pathname.startsWith('/' + prefix), true); assert.equal(url.hash, '');
  assert.equal(url.search, '?sslmode=disable');
  return raw;
}
async function run(): Promise<void> {
  assert.equal(process.env.AG_NATIVE_DEVICE_JOINED_ALLOW, 'disposable_pg17_10');
  const nativeDSN = disposable('AG_NATIVE_DEVICE_JOINED_NATIVE_DSN', 'native_device_joined_');
  const kernelDSN = disposable('AG_NATIVE_DEVICE_JOINED_KERNEL_DSN', 'ag_kernel_test_device_joined_');
  const binary = process.env.AG_NATIVE_DEVICE_JOINED_BINARY;
  assert.ok(binary && isAbsolute(binary) && binary.includes('/tmp/native-device-joined/'));
  const binarySHA256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const buildInfo = execFileSync(process.env.AG_NATIVE_DEVICE_JOINED_GO ?? 'go', ['version', '-m', binary],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 131072 });
  const nativeHead = /vcs\.revision=([a-f0-9]{40})/.exec(buildInfo)?.[1];
  assert.ok(nativeHead); assert.match(buildInfo, /vcs\.modified=false/);
  const gatewayRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const gatewayHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gatewayRoot, encoding: 'utf8', timeout: 5000 }).trim();
  assert.match(gatewayHead, /^[a-f0-9]{40}$/);
  const sha256 = async (url: URL): Promise<string> => createHash('sha256').update(await readFile(url)).digest('hex');
  const sourceHashes = { harness: await sha256(new URL(import.meta.url)),
    nativeFixture: await sha256(new URL('./fixtures/native-device-joined/main.go', import.meta.url)),
    sdkHTTP: await sha256(new URL(import.meta.resolve('@agent-teams/account-gateway/http'))) };
  const consumerId = 'joined-device-' + randomUUID(), ownerRef = 'joined-device-owner';
  const managementCredential = randomBytes(32).toString('base64url'), callbackCredential = randomBytes(32).toString('base64url');
  const scratch = await mkdtemp(resolve(dirname(fileURLToPath(import.meta.url)), '../../../tmp/native-device-joined-'));
  const configFile = join(scratch, 'native-config.json');
  await writeFile(configFile, JSON.stringify({ DSN: nativeDSN, Consumer: consumerId, Control: managementCredential, Callback: callbackCredential }), { mode: 0o600 });
  phase = 'native-start';
  child = spawn(binary, [configFile], { env: { GIN_MODE: 'release' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin!.on('error', () => undefined);
  // Native diagnostics are retained privately, never reflected into public results.
  let diagnostic = '';
  child.stderr!.on('data', (bytes: Buffer) => { if (diagnostic.length < 8192) diagnostic += bytes.toString(); });
  childExit = new Promise(resolve => { child!.once('error', () => resolve(-1)); child!.once('close', resolve); });
  const frames = createInterface({ input: child.stdout!, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const next = async (event: string): Promise<Record<string, unknown>> => {
    const line = await bounded(frames.next()); assert.equal(line.done, false); assert.ok(line.value.length <= 4096);
    const result = JSON.parse(line.value) as Record<string, unknown>; assert.equal(result.event, event); return result;
  };
  const ready = await next('ready');
  assert.equal(typeof ready.nativeOrigin, 'string'); assert.equal(typeof ready.controllerOrigin, 'string');
  for (const origin of [ready.nativeOrigin, ready.controllerOrigin]) {
    const url = new URL(origin as string); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); assert.ok(url.port);
  }
  phase = 'kernel-migrations';
  pool = new pg.Pool({ connectionString: kernelDSN, max: 8, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on('error', () => undefined);
  const version = (await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")).rows[0];
  assert.equal(version.db, new URL(kernelDSN).pathname.slice(1)); assert.match(version.version, /^17\.10(?:$| )/);
  assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')")).rowCount, 0);
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  const kernel = new PostgresKernel(pool), secrets = new IntentSecrets(randomBytes(32), randomBytes(32));
  const store = new PostgresManagementStore(pool, secrets), worker = randomUUID(), context = { consumerId };
  await kernel.issuer(context); await kernel.heartbeat(context, worker);
  const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
  const publicToken = randomBytes(32).toString('base64url'), foreignToken = randomBytes(32).toString('base64url');
  const bearer = (token: string, owner: string) => ({ token, role: 'management' as const, consumerId,
    ownerRefs: [owner], profileIds: [codexOAuthProfile.profile], preparation: { accountRefs: [], subjectRef: 'joined-device-policy',
      policyRevision: 1, bindingRevision: 1, profileId: codexOAuthProfile.profile, limits, maxRunMs: 60_000 } });
  const cfg = { native: { executable: '/unused', sha256: 'unused', bootstrapFile: '/unused', authorityDir: '/unused',
    origin: ready.nativeOrigin as string, originRef: 'joined-device-origin', uid: 1, gid: 1 },
    consumer: { consumerId, managementCredential, callbackCredential, executionCredential: randomBytes(32).toString('base64url'),
      cleanupCredential: randomBytes(32).toString('base64url') },
    profile: { profile: 'openai-responses-apikey-v1', baseURL: 'https://api.openai.com/v1', model: 'fixture-unused',
      qualificationRef: 'joined-device-unused-apikey', limits, providerTokenUpperBound: 100 },
    oauthEnrollment: { enabled: true, profile: 'openai-codex-oauth-responses-v1', modelScope: ['gpt-5.6-sol'],
      qualificationRef: 'controlled-source-v1', limits, providerTokenUpperBound: 100 },
    bearers: [bearer(publicToken, ownerRef), bearer(foreignToken, 'joined-foreign-owner')]
  } satisfies Pick<ServiceConfig, 'native' | 'consumer' | 'profile' | 'oauthEnrollment' | 'bearers'>;
  const control = composeServiceControl(cfg, kernel, store, secrets, worker);
  const enrollment = { originRef: cfg.native.originRef, engineIncarnation: randomUUID(), worker };
  const { authority, transport } = composeServiceNative(cfg, control, kernel, store, enrollment);
  const callbackOrigin = await listen(authority.createServer());
  const origin = await listen(createFacade({ kernel, store, management: control.management, bearers: control.bearers,
    profiles: control.catalog, enrollment, transport, intentHmacKey: randomBytes(32) }));
  child.stdin!.write(JSON.stringify({ callbackOrigin }) + '\n'); await next('configured');
  const client = createManagementClient({ role: 'management', origin, token: publicToken });
  const foreign = createManagementClient({ role: 'management', origin, token: foreignToken });
  const command = { operationId: randomUUID(), ownerRef, profileId: codexOAuthProfile.profile, displayName: 'Controlled joined device', method: 'device_code' as const };
  const poll = { operationId: command.operationId, ownerRef };
  const stats = async (): Promise<Record<string, number>> => {
    const response = await fetch(ready.controllerOrigin + '/stats', { headers: { authorization: 'Bearer ' + managementCredential }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); return await response.json() as Record<string, number>;
  };
  phase = 'fresh-device-handoff';
  const begun = await client.beginOAuth(command);
  assert.equal(begun.operation.state, 'pending'); assert.ok(begun.deviceAuthorization);
  assert.equal(begun.deviceAuthorization.userCode, 'JOIN-ED42');
  assert.equal(begun.deviceAuthorization.verificationURL, 'https://auth.openai.com/codex/device');
  assert.equal(begun.deviceAuthorization.intervalSeconds, 1); assert.equal(begun.authorizationURL, undefined);
  const journal = await store.readJournal(context, command.operationId); assert.ok(journal);
  assert.equal((await client.get(journal.accountRef)).state, 'staging');
  const duplicate = await client.beginOAuth(command); assert.equal(duplicate.deviceAuthorization, undefined);
  assert.equal((await client.readOAuth(command.operationId)).state, 'pending');
  assert.deepEqual(await stats(), { starts: 1, polls: 0, exchanges: 0, checks: 0, unexpected: 0 });
  phase = 'owner-boundary';
  const denied = (error: unknown): boolean => error instanceof GatewayError && error.diagnostic?.code === 'forbidden';
  await assert.rejects(foreign.pollDeviceOAuth(poll), denied);
  await assert.rejects(client.pollDeviceOAuth({ ...poll, ownerRef: 'joined-foreign-owner' }), denied);
  phase = 'pending-provider-poll';
  await delay(1100);
  assert.equal((await client.pollDeviceOAuth(poll)).state, 'pending');
  assert.deepEqual(await stats(), { starts: 1, polls: 1, exchanges: 0, checks: 0, unexpected: 0 });
  const accepted = await fetch(ready.controllerOrigin + '/authorize', { method: 'POST', headers: { authorization: 'Bearer ' + managementCredential } });
  assert.equal(accepted.status, 200); await accepted.arrayBuffer();
  await delay(1100);
  phase = 'authorized-native-custody-and-descriptor';
  const applied = await client.pollDeviceOAuth(poll); assert.equal(applied.state, 'applied');
  assert.equal((await client.get(journal.accountRef)).state, 'active');
  const mapping = await store.mapping(context, journal.generation); assert.ok(mapping);
  assert.equal(mapping.descriptor.generation, journal.generation); assert.equal(mapping.descriptor.profile, codexOAuthProfile.profile);
  assert.equal(mapping.descriptor.model, codexOAuthProfile.model); assert.equal(mapping.descriptor.nativePhysicalIdentity, journal.generation);
  assert.ok(mapping.descriptor.nativeId > 0);
  phase = 'duplicate-and-readback-no-replay';
  for (const result of await Promise.all(Array.from({ length: 4 }, () => client.pollDeviceOAuth(poll)))) assert.equal(result.state, 'applied');
  assert.equal((await client.readOAuth(command.operationId)).state, 'applied');
  assert.deepEqual(await client.beginOAuth(command), { operation: applied });
  const final = await stats(); assert.deepEqual(final, { starts: 1, polls: 2, exchanges: 1, checks: 1, unexpected: 0 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_management.transient_intents WHERE consumer=$1', [consumerId])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1', [consumerId])).rows[0].n, 0);
  child.stdin!.end('stop\n'); stopped = true;
  const closed = await next('closed'); assert.equal(closed.plaintextCredentials, 0); assert.equal(closed.retainedDeviceMaterial, 0);
  assert.equal(await bounded(childExit), 0); assert.equal(diagnostic, '');
  phase = 'completed';
  const receipt = { phase, contract: 'gateway-native-device-joined/v1', nativeBinarySHA256: binarySHA256, nativeHead, gatewayHead, sourceHashes,
    nativeHTTP: true, gatewayFacadeAndSDK: true, liveOwnerCallback: true, actualPostgreSQL: true,
    handoffFreshOnly: true, wrongOwnerDenied: true, account: 'active', descriptor: 'verified',
    provider: final, plaintextCredentials: 0, retainedDeviceMaterial: 0, inferenceRequests: 0 };
  await writeFile(join(scratch, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); report({ ...receipt, receiptPath: join(scratch, 'receipt.json') });
}
try { await run(); }
catch (error) {
  report({ phase: 'failed', at: phase, code: error instanceof assert.AssertionError ? 'assertion_failed' : 'qualification_failed',
    ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'string' ? error.actual.slice(0, 80) : typeof error.actual,
      expected: typeof error.expected === 'string' ? error.expected.slice(0, 80) : typeof error.expected,
      frame: error.stack?.split('\n').find(line => line.includes('native-device-joined.ts'))?.trim() } : {}) });
  process.exitCode = 1;
} finally {
  if (child && !stopped) child.stdin!.end('stop\n');
  if (childExit) await bounded(childExit, 5000).catch(() => { child?.kill('SIGTERM'); });
  for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  await pool?.end();
}
