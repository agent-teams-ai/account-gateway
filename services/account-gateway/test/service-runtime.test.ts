// Actual service lifecycle/restart: production Go CLI + Node entry + externally
// migrated NEW disposable PG17.10 + controlled TLS Responses. No paid provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as c from '@agent-teams/account-gateway/contracts';
import { createManagementClient, createExecutionClient, GatewayError } from '@agent-teams/account-gateway/http';
import * as serviceComposition from '../src/service.ts';
import type { Service, ProcessBinding, Retirement } from '../src/service.ts';
import type { ServiceConfig } from '../src/service-config.ts';
import { strictJSON } from '../src/facade-ingress.ts';
import { object } from '../src/native-wire.ts';
import { captureOAuthEnrollmentConfig, captureServiceProfiles, captureServiceBearers, openRouterProfile, ServiceError } from '../src/service-config.ts';
import { AccountManagement } from '../src/management.ts';
import { PostgresKernel } from '../src/postgres.ts';
import { FacadeBearers } from '../src/facade.ts';
import { KernelError } from '../src/domain.ts';

// Keep the production restart scenario executable against the exact old base:
// its meaningful RED must be missing automatic closure, not a missing import.
const composition: { startService: typeof serviceComposition.startService;
  composeServiceRetirementReadback?: (native: Pick<ServiceConfig['native'], 'executable' | 'authorityDir' | 'originRef'>) =>
    (current: ProcessBinding, selector: Readonly<{ originRef: string; engineIncarnation: string }>, signal: AbortSignal) => Promise<Retirement | undefined> } = serviceComposition;
const { startService } = composition;
function composeServiceRetirementReadback(native: Pick<ServiceConfig['native'], 'executable' | 'authorityDir' | 'originRef'>) {
  assert.ok(composition.composeServiceRetirementReadback, 'private readonly adapter required');
  return composition.composeServiceRetirementReadback(native);
}

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
async function typecheckFixture(path: string): Promise<void> {
  await promisify(execFile)(process.execPath, [join(workspace, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict',
    '--target', 'ES2024', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions',
    '--erasableSyntaxOnly', '--types', 'node', '--typeRoots', join(workspace, 'node_modules/@types'), path],
  { cwd: workspace, timeout: 15_000, maxBuffer: 65_536 });
}

test('retirement readback: real readonly child, exact decimal binding, strict bounded EOF/exit and disposal',
  { timeout: 25_000 }, async () => {
    const evidence = join(workspace, '.qualification/c-retirement-readback-checks'); mkdirSync(evidence, { recursive: true });
    const dir = mkdtempSync(join(evidence, 'child-')), executable = join(dir, 'readonly.mts');
    const current: ProcessBinding = { originRef: 'source-local', bootId: randomUUID(), incarnation: randomUUID(),
      pid: '2147483647', birthTicks: '9007199254740993', lockDevice: '18446744073709551615', lockInode: '9007199254740995' };
    const selector = { originRef: current.originRef, engineIncarnation: randomUUID() };
    // A real executable fixture exercises production spawn/stdin/stdout. Its
    // handwritten TS contract is independently typechecked before execution.
    const source = `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ProcessBinding, Retirement } from ${JSON.stringify(fileURLToPath(new URL('../src/service.ts', import.meta.url)))};
const args = process.argv.slice(2), mode = basename(args[2]);
assert.deepEqual(args, ['--read-retirement', '--authority-dir', args[2], '--origin-ref', 'source-local']);
assert.equal(process.cwd(), '/');
if (mode === 'latched') appendFileSync(args[2] + '.spawns', 'spawn\\n');
let bytes = 0; const chunks: Buffer[] = [];
for await (const chunk of process.stdin) { const b = Buffer.from(chunk as Uint8Array); bytes += b.length; assert.ok(bytes <= 4096); chunks.push(b); }
const input: { current: ProcessBinding; selectors: { originRef: string; engineIncarnation: string }[] } = JSON.parse(Buffer.concat(chunks).toString());
assert.deepEqual(input, ${JSON.stringify({ current, selectors: [selector] })});
writeFileSync(args[2] + '.pid', String(process.pid), { flag: mode === 'latched' ? 'w' : 'wx' });
if (mode === 'latched') await new Promise<void>(resolve => {
  const poll = setInterval(() => { if (existsSync(args[2] + '.release')) { clearInterval(poll); resolve(); } }, 10);
});
const receipt = { binding: { ...input.current, incarnation: input.selectors[0].engineIncarnation, pid: '123', birthTicks: '9007199254740997' },
  scope: 'exact-local-process-transport-teardown-v1', method: mode === 'observed' ? 'observed-child-exit' : 'reacquired-after-supervisor-loss' } satisfies Retirement;
let output = JSON.stringify({ receipts: [receipt] });
switch (mode) {
  case 'boot': receipt.binding = { ...receipt.binding, bootId: '00000000-0000-4000-8000-000000000001' }; break;
  case 'lock': receipt.binding = { ...receipt.binding, lockInode: '9007199254740996' }; break;
  case 'origin': receipt.binding = { ...receipt.binding, originRef: 'foreign' }; break;
  case 'incarnation': receipt.binding = { ...receipt.binding, incarnation: input.current.incarnation }; break;
  case 'numeric': receipt.binding = { ...receipt.binding, birthTicks: 9007199254740997 as unknown as string }; break;
  case 'zero': receipt.binding = { ...receipt.binding, pid: '0' }; break;
  case 'decimal': receipt.binding = { ...receipt.binding, birthTicks: '01' }; break;
  case 'range': receipt.binding = { ...receipt.binding, lockDevice: '18446744073709551616' }; break;
  case 'scope': receipt.scope = 'engine-started'; break;
  case 'method': receipt.method = 'timeout'; break;
}
output = JSON.stringify({ receipts: [receipt] });
if (mode === 'missing') output = '{"receipts":[]}';
if (mode === 'multiple') output = JSON.stringify({ receipts: [receipt, receipt] });
if (mode === 'duplicate') output = '{"receipts":[],"receipts":' + JSON.stringify([receipt]) + '}';
if (mode === 'escaped-duplicate') output = '{"receipts":[],"receip\\\\u0074s":' + JSON.stringify([receipt]) + '}';
if (mode === 'case') output = JSON.stringify({ receipts: [receipt], Receipts: [] });
if (mode === 'unknown') output = JSON.stringify({ receipts: [receipt], extra: true });
if (mode === 'nested-extra') output = JSON.stringify({ receipts: [{ ...receipt, extra: true }] });
if (mode === 'trailing') output += '{}';
if (mode === 'overflow') output += ' '.repeat(4097);
if (mode === 'truncated') output = output.slice(0, -1);
if (mode === 'stderr') process.stderr.write('x'.repeat(4097));
if (mode === 'utf8') process.stdout.write(Buffer.from([0xff]));
process.stdout.write(output);
if (mode === 'nonzero') process.exitCode = 1;
if (mode === 'no-eof' || mode === 'abort') setTimeout(() => process.stdout.write(output), 10_000);
`;
    writeFileSync(executable, source, { mode: 0o700 });
    try {
      await typecheckFixture(executable);
      const latchedPath = join(dir, 'latched');
      const latched = composeServiceRetirementReadback({ executable, authorityDir: latchedPath, originRef: current.originRef });
      const first = latched(current, selector, new AbortController().signal);
      try {
        const readyDeadline = Date.now() + 3000;
        while (!existsSync(latchedPath + '.pid') && Date.now() < readyDeadline) await delay(10);
        assert.ok(existsSync(latchedPath + '.pid'), 'exact owned helper is active');
        for (let tick = 0; tick < 3; tick++)
          assert.equal(await latched(current, selector, new AbortController().signal), undefined, 'active helper denies another tick');
        assert.equal(readFileSync(latchedPath + '.spawns', 'utf8'), 'spawn\n', 'only one actual executable spawned');
      } finally { writeFileSync(latchedPath + '.release', 'release'); }
      assert.equal((await first)?.binding.incarnation, selector.engineIncarnation, 'positive exact close');
      assert.equal((await latched(current, selector, new AbortController().signal))?.binding.incarnation,
        selector.engineIncarnation, 'same adapter permits lookup after close');
      assert.equal(readFileSync(latchedPath + '.spawns', 'utf8'), 'spawn\nspawn\n');
      const read = (mode: string, signal = new AbortController().signal) => composeServiceRetirementReadback({
        executable, authorityDir: join(dir, mode), originRef: current.originRef })(current, selector, signal);
      for (const mode of ['observed','reacquired']) {
        const receipt = await read(mode);
        assert.equal(receipt?.binding.incarnation, selector.engineIncarnation);
        assert.equal(receipt?.binding.birthTicks, '9007199254740997');
        assert.equal(receipt?.binding.lockDevice, current.lockDevice);
      }
      for (const mode of ['boot','lock','origin','incarnation','numeric','zero','decimal','range','scope','method','missing','multiple',
        'duplicate','escaped-duplicate','case','unknown','nested-extra','trailing','overflow','truncated','stderr','utf8','nonzero'])
        assert.equal(await read(mode), undefined, mode);
      const start = Date.now(); assert.equal(await read('no-eof'), undefined);
      assert.ok(Date.now() - start < 5500, 'five-second call with scheduling tolerance');
      const abort = new AbortController(), pending = read('abort', abort.signal);
      const abortDeadline = Date.now() + 3000;
      while (!existsSync(join(dir, 'abort.pid')) && Date.now() < abortDeadline) await delay(10);
      assert.ok(existsSync(join(dir, 'abort.pid')), 'owned child reached stdin EOF before abort');
      abort.abort(); assert.equal(await pending, undefined);
      for (const mode of ['no-eof','abort']) {
        const pid = readFileSync(join(dir, mode + '.pid'), 'utf8');
        assert.equal(existsSync('/proc/' + pid), false, 'owned readonly child disposed');
      }
      assert.equal((await read('after-timeout'))?.binding.incarnation, selector.engineIncarnation, 'fresh query after timeout');
      abort.abort(); assert.equal(await read('pre-abort', abort.signal), undefined);
      assert.equal(existsSync(join(dir, 'pre-abort.pid')), false);
      assert.equal(await composeServiceRetirementReadback({ executable: join(dir, 'missing-executable'),
        authorityDir: dir, originRef: current.originRef })(current, selector, new AbortController().signal), undefined);
      const largeOrigin = 'x'.repeat(4096);
      assert.equal(await composeServiceRetirementReadback({ executable, authorityDir: join(dir, 'oversize-input'), originRef: largeOrigin })(
        { ...current, originRef: largeOrigin }, { ...selector, originRef: largeOrigin }, new AbortController().signal), undefined);
      assert.equal(existsSync(join(dir, 'oversize-input.pid')), false, 'input capped before spawning');
      for (const selected of [{ originRef: current.originRef, engineIncarnation: current.incarnation },
        { ...selector, originRef: 'foreign' }])
        assert.equal(await composeServiceRetirementReadback({ executable, authorityDir: join(dir, 'invalid-selector'), originRef: current.originRef })(
          current, selected, new AbortController().signal), undefined);
      assert.equal(existsSync(join(dir, 'invalid-selector.pid')), false, 'current/foreign selectors cannot spawn');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

test('source catalog: singleton compatibility and finite simultaneous per-profile grants', () => {
  const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 100 };
  const profile = { profile: 'openai-responses-apikey-v1', baseURL: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-flash',
    qualificationRef: 'source-mimo', limits, providerTokenUpperBound: 1000 };
  const secondProfile = { ...openRouterProfile, qualificationRef: 'source-openrouter', providerTokenUpperBound: 2000,
    limits: { ...limits, requests: 2, concurrency: 1, requestBytes: 2048, outputBytes: 4096, tokens: 50 } };
  const singleton = captureServiceProfiles({ profile });
  assert.deepEqual(singleton, [profile]);
  const profiles = captureServiceProfiles({ profile, secondProfile });
  assert.deepEqual(profiles, [profile, secondProfile]);
  assert.ok(Object.isFrozen(profiles[1].limits));
  const grant = { token: 'source-management-catalog', role: 'management' as const, consumerId: 'source-consumer', ownerRefs: ['owner'],
    preparation: { accountRefs: [], subjectRef: 'subject', policyRevision: 1, bindingRevision: 1,
      profileId: secondProfile.profile, limits: secondProfile.limits, maxRunMs: 1000 } };
  const broadCaptured = captureServiceBearers([grant], grant.consumerId, profiles);
  assert.equal(broadCaptured.length, 1);
  assert.equal(Object.hasOwn(broadCaptured[0], 'profileIds'), false, 'canonical capture preserves absent broad authority');
  const denied = (work: () => unknown) => assert.throws(work, e => e instanceof ServiceError && e.code === 'config_denied');
  const legacy = new FacadeBearers([grant]).resolve(grant.token);
  assert.ok(legacy && legacy.role === 'management'); assert.equal(Object.hasOwn(legacy, 'profileIds'), false);
  // Management narrowing is independent of the preparation profile and caps.
  const explicit = { ...grant, profileIds: [secondProfile.profile],
    preparation: { ...grant.preparation, profileId: profile.profile, limits: profile.limits } };
  assert.deepEqual(captureServiceBearers([explicit], grant.consumerId, profiles)[0], explicit);
  for (const profileIds of [[], [profile.profile, profile.profile], ['bad/profile'], ['x'.repeat(65)],
    Array.from({ length: 129 }, (_, i) => 'profile-' + i)]) {
    assert.throws(() => new FacadeBearers([{ ...grant, profileIds }]), e => e instanceof KernelError && e.code === 'invalid');
    denied(() => captureServiceBearers([{ ...grant, profileIds }], grant.consumerId, profiles));
  }
  for (const profileIds of [['unconfigured'], [1], null, 'profile'])
    denied(() => captureServiceBearers([{ ...grant, profileIds }], grant.consumerId, profiles));
  assert.equal(new FacadeBearers([{ ...grant, profileIds: Array.from({ length: 128 }, (_, i) => 'profile-' + i) }]).resolve(grant.token)?.role, 'management');
  const callerIds = [profile.profile], configured = { ...grant, profileIds: callerIds };
  const mapping = new FacadeBearers([configured]), captured = mapping.resolve(grant.token);
  assert.ok(captured && captured.role === 'management');
  callerIds[0] = secondProfile.profile;
  assert.deepEqual(captured.profileIds, [profile.profile]); assert.notEqual(captured.profileIds, callerIds);
  assert.ok(Object.isFrozen(captured.profileIds));
  mapping.replace([configured]);
  assert.equal(mapping.current(captured), false);
  const replaced = mapping.resolve(grant.token); assert.ok(replaced && replaced.role === 'management');
  assert.deepEqual(replaced.profileIds, [secondProfile.profile]);
  let profileReads = 0;
  const accessorGrant = { ...grant, get profileIds() {
    return ++profileReads <= 7 ? [secondProfile.profile] : undefined;
  } };
  const accessorCaptured = new FacadeBearers([accessorGrant]).resolve(grant.token);
  assert.ok(accessorCaptured && accessorCaptured.role === 'management');
  assert.deepEqual(accessorCaptured.profileIds, [secondProfile.profile], 'constructor cannot widen the supplied OpenRouter restriction');
  assert.equal(profileReads, 1, 'optional restriction is read once');
  assert.ok(Object.isFrozen(accessorCaptured.profileIds));
  const externalIds: string[] = [secondProfile.profile];
  let externalProfileIds: string[] | undefined = externalIds;
  let canonicalProfileReads = 0;
  const callerBearer = { ...grant, get profileIds() { canonicalProfileReads++; return externalProfileIds; } };
  const serviceCaptured = captureServiceBearers([callerBearer], grant.consumerId, profiles);
  assert.equal(canonicalProfileReads, 1, 'canonical capture reads the caller restriction once');
  externalIds[0] = profile.profile;
  externalProfileIds = undefined;
  assert.notEqual(serviceCaptured[0], callerBearer, 'canonical capture owns bearer data');
  assert.deepEqual(serviceCaptured[0].profileIds, [secondProfile.profile]);
  assert.ok(Object.isFrozen(serviceCaptured[0].profileIds));
  const serviceResolved = new FacadeBearers(serviceCaptured).resolve(grant.token);
  assert.ok(serviceResolved && serviceResolved.role === 'management');
  assert.deepEqual(serviceResolved.profileIds, [secondProfile.profile], 'later caller getter state cannot widen canonical authority');
  for (const patch of [{ profile: profile.profile }, { profile: 'openrouter-alias' }, { baseURL: profile.baseURL },
    { model: profile.model }, { endpoint: secondProfile.baseURL }, { providerTokenUpperBound: 49 },
    { limits: { ...limits, concurrency: 5 } }]) {
    denied(() => captureServiceProfiles({ profile, secondProfile: { ...secondProfile, ...patch } }));
  }
  denied(() => captureServiceBearers([{ ...grant, preparation: { ...grant.preparation, limits } }], grant.consumerId, profiles));
  const run = { token: 'source-run-catalog', role: 'run-control' as const, consumerId: grant.consumerId,
    ownerRefs: ['owner'], profileIds: profiles.map(p => p.profile), limits: secondProfile.limits, maxRunMs: 1000 };
  assert.equal(captureServiceBearers([run], run.consumerId, profiles).length, 1);
  denied(() => captureServiceBearers([{ ...run, limits }], run.consumerId, profiles));
  denied(() => captureServiceBearers([{ ...run, profileIds: ['unconfigured'] }], run.consumerId, profiles));
  denied(() => captureServiceBearers([{ ...run, profileIds: [profile.profile, profile.profile] }], run.consumerId, profiles));
  // Legacy opt-in capture stays valid, but startup needs its separate receipt
  // and all five limits; a singleton qualification is never substituted.
  const oauthEnrollment = captureOAuthEnrollmentConfig({ enabled: true, profile: 'openai-codex-oauth-responses-v1', modelScope: ['gpt-6.1-sol'] });
  denied(() => captureServiceProfiles({ profile, oauthEnrollment }));
  const catalog = captureServiceProfiles({ profile, secondProfile, oauthEnrollment: { ...oauthEnrollment,
    qualificationRef: 'source-codex', limits: secondProfile.limits, providerTokenUpperBound: 1000 } });
  assert.equal(catalog[2].profile, 'openai-codex-oauth-responses-v1');
  assert.equal(catalog[2].baseURL, 'https://chatgpt.com/backend-api/codex');
  assert.equal(catalog[2].qualificationRef, 'source-codex');
});

// Fixture-owned input projection. Actual startService validates production
// configuration; this test independently checks the disposable designation.
interface FixtureConfig {
  kernelDSN: string; facadeOrigin: string; callbackOrigin: string;
  durableFacts: { maxServiceFacts: number; maxConsumerFacts: number; maxAccountFacts: number;
    workerSlots: number; issuerSlots: number };
  native: { bootstrapFile: string; authorityDir: string; uid: number; gid: number;
    executable: string; sha256: string; origin: string; originRef: string };
  consumer: { consumerId: string };
  profile: { profile: string; model: string; qualificationRef: string;
    baseURL: string; limits: c.Prepare['limits']; providerTokenUpperBound: number };
  bearers: { role: 'management' | 'run-control'; ownerRefs: string[]; token: string; maxRunMs?: number }[];
}

// TEST numbers only, deliberately distinct from safety defaults. These are not
// measured production caps. The protected fixture factory must supply them.
const testFacts: FixtureConfig['durableFacts'] = Object.freeze({
  maxServiceFacts: 128, maxConsumerFacts: 96, maxAccountFacts: 64, workerSlots: 2, issuerSlots: 3,
});
async function assertStoredFacts(pool: pg.Pool, consumer: string, expected: FixtureConfig['durableFacts']): Promise<void> {
  const rows = (await pool.query<FixtureConfig['durableFacts']>(`SELECT
    b.capacity::integer AS "maxServiceFacts",c.fact_limit::integer AS "maxConsumerFacts",
    c.account_fact_limit::integer AS "maxAccountFacts",c.worker_slots AS "workerSlots",c.issuer_slots AS "issuerSlots"
    FROM ag_kernel.fact_budget b CROSS JOIN ag_kernel.consumers c WHERE b.singleton AND c.consumer=$1`, [consumer])).rows;
  assert.deepEqual(rows, [expected], 'configured facts must reach actual persisted kernel policy');
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
  ensure(['postgres:', 'postgresql:'].includes(u.protocol) && u.host === '127.0.0.1:5432' && ['postgres', 'rr_dmin'].includes(u.username) &&
    !u.password && !u.hash && u.search === '?sslmode=disable' &&
    new RegExp('^/ag_service_entry_' + kind + '_[a-f0-9]{32}$').test(u.pathname), 'explicit disposable database');
  return u.pathname.slice(1);
}

// HOST-only root fixture exception: the isolated standard-library bridge owns
// both pidfds for the entire loss experiment. No numeric signal fallback.
interface FixtureProcess { pid: string; birthTicks: string; parent: string }
interface FixtureProcessHandles { kill(): Promise<void>; close(): Promise<void> }
type FixturePinRequest = { bootId: string; processes: readonly [FixtureProcess, FixtureProcess] } | { command: 'kill' };
async function pinFixtureProcesses(bootId: string, processes: readonly [FixtureProcess, FixtureProcess]): Promise<FixtureProcessHandles> {
  const source = String.raw`
import json, os, select, signal, sys, time
fds = []
deadline = time.monotonic() + 20
def read_command():
    line = b''
    while not line.endswith(b'\n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError()
        chunk = os.read(0, 4097 - len(line))
        line += chunk
        if not chunk or len(line) > 4096 or b'\n' in line[:-1]:
            raise RuntimeError()
    return json.loads(line)
def reply(state):
    print(json.dumps({'state': state}), flush=True)
try:
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError()
    request = read_command()
    if set(request) != {'bootId', 'processes'} or len(request['processes']) != 2:
        raise RuntimeError()
    # Capture BOTH handles before inspecting actual birth, parent or boot.
    for p in request['processes']:
        if set(p) != {'pid', 'birthTicks', 'parent'} or not all(isinstance(v, str) and v.isdecimal() and int(v) > 0 for v in p.values()):
            raise RuntimeError()
        fds.append(os.pidfd_open(int(p['pid']), 0))
    if request['processes'][0]['pid'] == request['processes'][1]['pid']:
        raise RuntimeError()
    with open('/proc/sys/kernel/random/boot_id', 'r', encoding='ascii') as stream:
        if stream.read(128).strip() != request['bootId']:
            raise RuntimeError()
    if select.select(fds, [], [], 0)[0]:
        raise RuntimeError()
    for p in request['processes']:
        with open('/proc/' + p['pid'] + '/stat', 'r', encoding='ascii') as stream:
            stat = stream.read(4097)
        if len(stat) > 4096:
            raise RuntimeError()
        fields = stat[stat.rfind(')') + 2:].split()
        if fields[0] == 'Z' or fields[1] != p['parent'] or fields[19] != p['birthTicks']:
            raise RuntimeError()
    if select.select(fds, [], [], 0)[0]:
        raise RuntimeError()
    reply('pinned')
    command = read_command()
    if command == {'command': 'kill'}:
        for fd in fds:
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
            except ProcessLookupError:
                pass
        pending = list(fds)
        death_deadline = min(deadline, time.monotonic() + 5)
        while pending:
            remaining = death_deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError()
            exited = select.select(pending, [], [], remaining)[0]
            pending = [fd for fd in pending if fd not in exited]
        reply('exited')
        command = read_command()
    if command != {'command': 'close'}:
        raise RuntimeError()
except BaseException:
    sys.exit(1)
finally:
    for fd in fds:
        os.close(fd)
`;
  const child = spawn('/usr/bin/python3', ['-I', '-u', '-c', source],
    { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: false });
  let ended = false, lost = false, killed = false, output = '', bytes = 0, diagnostics = 0;
  let pending: { expected: 'pinned' | 'exited'; resolve(): void; reject(error: Error): void } | undefined;
  const deny = () => {
    lost = true; pending?.reject(new Error('service fixture: pinned bridge lost')); pending = undefined;
  };
  const closed = new Promise<boolean>(resolve => child.once('close', (code, exitSignal) => {
    const accepted = !lost && !pending && code === 0 && exitSignal === null && output === '';
    ended = true; deny(); resolve(accepted);
  }));
  child.on('error', deny); child.stdin.on('error', deny); child.stdout.on('error', deny); child.stderr.on('error', deny);
  child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 1024) deny(); });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length; if (lost || bytes > 1024) { deny(); return; }
    output += chunk.toString('utf8');
    const newline = output.indexOf('\n'); if (newline < 0) return;
    const line = output.slice(0, newline); output = output.slice(newline + 1);
    try {
      const message = object(strictJSON(Buffer.from(line)), ['state']);
      if (!pending || output !== '' || message.state !== pending.expected) { deny(); return; }
      const accepted = pending; pending = undefined; accepted.resolve();
    } catch { deny(); }
  });
  const bounded = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('service fixture: pinned bridge deadline')), ms);
    })]); } finally { clearTimeout(timer); }
  };
  const send = async (message: FixturePinRequest, expected: 'pinned' | 'exited') => {
    if (lost || ended || pending) fail('pinned bridge unavailable');
    const input = Buffer.from(JSON.stringify(message) + '\n'); ensure(input.length <= 4096, 'pinned bridge input bound');
    const receipt = new Promise<void>((resolve, reject) => { pending = { expected, resolve, reject }; });
    child.stdin.write(input); await bounded(receipt, 6000);
  };
  const close = async () => {
    if (!ended && !lost) child.stdin.end('{"command":"close"}\n');
    else if (!ended) child.kill('SIGKILL'); // Only our retained bridge ChildProcess.
    try { ensure(await bounded(closed, 5000), 'pinned bridge exact close'); }
    catch (error) {
      if (!ended) child.kill('SIGKILL');
      await bounded(closed, 1000).catch(() => undefined); throw error;
    }
  };
  try { await send({ bootId, processes }, 'pinned'); }
  catch { deny(); await close().catch(() => undefined); return fail('pinned bridge capture'); }
  return { async kill() {
    if (killed) return;
    try { await send({ command: 'kill' }, 'exited'); killed = true; }
    catch { deny(); throw new Error('service fixture: pinned bridge signal unknown'); }
  }, close };
}

test('production service entry: startup rollback, SAME OPEN, abrupt held-stream loss and automatic exact old retirement closure',
  { timeout: 150_000 }, async () => {
    if (process.env.AG_SERVICE_ENTRY_ALLOW !== 'new_disposable_root_pg17_10' || process.geteuid?.() !== 0)
      fail('NOT_RUN explicit root disposable fixture required');
    // Manifest contains root/server-only fixture configuration. No keys/DSNs
    // or native bootstrap JSON are accepted through environment variables.
    const manifest = object(strictJSON(protectedFile(installation + '/fixture.json')),
      ['serviceConfig','nativeDSN','gatewaySourceRef','nativeSourceRef','normHash','retirementReadbackSources']);
    // Root must select the actual accepted patched service/native tuple. The
    // historical fixture is deliberately insufficient for this new scenario.
    const selected = object(manifest.retirementReadbackSources,
      ['gatewayBaseRef','nativeBaseRef','serviceSha256','testSha256','nativeExecutableSha256']);
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    ensure(selected.gatewayBaseRef === 'bc36b9ad16a90d1e45f7b6e30e16e0070b7905e5' &&
      selected.nativeBaseRef === 'b7d746411cb590af5156fe16436d3182c209b379' &&
      typeof manifest.gatewaySourceRef === 'string' && /^[a-f0-9]{40}$/.test(manifest.gatewaySourceRef) &&
      typeof manifest.nativeSourceRef === 'string' && /^[a-f0-9]{40}$/.test(manifest.nativeSourceRef) &&
      selected.serviceSha256 === digest(readFileSync(new URL('../src/service.ts', import.meta.url))) &&
      selected.testSha256 === digest(readFileSync(fileURLToPath(import.meta.url))) &&
      manifest.normHash === '66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0', 'selected readback source pins');
    ensure(typeof manifest.serviceConfig === 'string' && /^\/root\/account_gateway_service_entry_[a-f0-9]{32}\/service.json$/.test(manifest.serviceConfig), 'fixture root');
    ensure(typeof manifest.nativeDSN === 'string', 'native database designation');
    const configFile = manifest.serviceConfig as string, cfg = strictJSON(protectedFile(configFile)) as FixtureConfig, nativeDSN = manifest.nativeDSN as string;
    ensure(selected.nativeExecutableSha256 === cfg.native.sha256 && /^[a-f0-9]{64}$/.test(cfg.native.sha256), 'selected native executable pin');
    assert.deepEqual(cfg.durableFacts, testFacts, 'explicit TEST fact configuration required');
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
    ensure(typeof control!.maxRunMs === 'number' && control!.maxRunMs >= 90_000, 'explicit TEST restart run duration');
    const ownerRef = management!.ownerRefs[0], dummy = 'dummy-service-entry-only-' + randomUUID();
    const kernelPool = new pg.Pool({ connectionString: cfg.kernelDSN, max: 2, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    const nativePool = new pg.Pool({ connectionString: nativeDSN, max: 2, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    kernelPool.on('error', () => undefined); nativePool.on('error', () => undefined);
    let service: Service | undefined, calls = 0, violation = false, phase = 'fixture';
    // Observe the REAL current tick and its REAL SQL cleanup claim without
    // replacing either result or authority. RED if refresh moves before cleanup
    // or receives false after any acquired claim, including old-incarnation work.
    const claimCleanup = PostgresKernel.prototype.claimCleanup, refreshOAuth = AccountManagement.prototype.refreshOAuth;
    let acquiredThisTick: boolean | undefined, skippedRefreshTicks = 0, tickViolation = false;
    PostgresKernel.prototype.claimCleanup = async function (this: PostgresKernel, ...args: Parameters<typeof claimCleanup>) {
      const claim = await claimCleanup.apply(this, args);
      if (args[0].consumerId === cfg.consumer.consumerId) acquiredThisTick = claim !== undefined;
      return claim;
    };
    AccountManagement.prototype.refreshOAuth = async function (this: AccountManagement, ...args: Parameters<typeof refreshOAuth>) {
      const result = await refreshOAuth.apply(this, args);
      if (args[0].consumerId === cfg.consumer.consumerId) {
        if (acquiredThisTick === undefined || (args[1] ?? false) !== acquiredThisTick) tickViolation = true;
        if (acquiredThisTick) { skippedRefreshTicks++; if (result !== 'idle') tickViolation = true; }
        acquiredThisTick = undefined;
      }
      return result;
    };
    const held = new Map<number, () => void>();
    // These references are captured only from this test's fresh owned process
    // tree, never an existing daemon or an unverified/reused numeric PID.
    let owned: FixtureProcessHandles | undefined;
    const processState = (pid: string) => {
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { state: fields[0], parent: fields[1], birthTicks: fields[19] };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const upstream = createServer({ cert: protectedFile(installation + '/tls/server.pem'), key: protectedFile(installation + '/tls/server-key.pem'),
      maxHeaderSize: 16_384, headersTimeout: 5000, requestTimeout: 5000 }, (req, res) => {
      void (async () => {
        const entry = ++calls; let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { const b = Buffer.from(chunk as Uint8Array); size += b.length; ensure(size <= 4096, 'upstream body bound'); chunks.push(b); }
        const body = object(strictJSON(Buffer.concat(chunks)), ['model','input','stream','store','service_tier','max_output_tokens']);
        ensure(entry <= 4 && req.method === 'POST' && req.url === '/v1/responses' && req.headers.authorization === 'Bearer ' + dummy &&
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
        if (entry >= 3) {
          await new Promise<void>(resolve => { held.set(entry, resolve); res.once('close', resolve); });
          held.delete(entry); if (res.destroyed) return;
        }
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
      phase = 'fact-config-denial';
      // Regression: silently defaulting, accepting extra keys or bypassing the
      // numeric/hierarchy checks would launch instead of returning config_denied.
      for (const durableFacts of [undefined, { ...testFacts, extra: 1 },
        { ...testFacts, issuerSlots: 0 }, { ...testFacts, maxAccountFacts: 97 }]) {
        const invalidFile = dirname(configFile) + '/invalid-facts-' + randomUUID() + '.json';
        writeFileSync(invalidFile, JSON.stringify({ ...cfg, durableFacts }), { flag: 'wx', mode: 0o600 });
        try {
          await assert.rejects(async () => {
            const unexpected = await startService(invalidFile); await unexpected.stop();
          }, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'config_denied');
        } finally { unlinkSync(invalidFile); }
      }
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
      // Regression: losing the service constructor's third argument persists
      // safety defaults instead of these independent protected TEST values.
      phase = 'service-fact-wiring';
      await assertStoredFacts(kernelPool, cfg.consumer.consumerId, testFacts);
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

      const run = async (input: c.Prepare) => {
        const response = await fetch(cfg.facadeOrigin + '/internal/v1/run-access', { method: 'POST',
          headers: { authorization: 'Bearer ' + control!.token, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        const r = object(await response.json(), ['operation','bearer','admission']), operation = c.preparationOperation.parse(r.operation);
        if (operation.state !== 'applied' || operation.result?.kind !== 'execution' || typeof r.bearer !== 'string') return fail('restart run-access');
        return { executionRef: operation.result.executionRef, admission: c.admission.parse(r.admission),
          client: createExecutionClient({ role: 'execution', origin: cfg.facadeOrigin, token: r.bearer, timeoutMs: 15_000 }) };
      };
      const freshInput = (): c.Prepare => ({ ...prepare, operationId: randomUUID(), invocationRef: randomUUID(),
        attemptRef: randomUUID(), deadline: new Date(Date.now() + 90_000).toISOString() });
      const body = (entry: number) => Buffer.from(JSON.stringify({ model: cfg.profile.model,
        input: [{ role: 'user', content: 'service question ' + entry }], stream: true, store: false, service_tier: 'default' }));
      phase = 'old-held-stream';
      const oldInput = freshInput(), old = await run(oldInput), oldId = randomUUID();
      const oldStream = await old.client.request(old.executionRef, { requestId: oldId, admission: old.admission, body: body(3) });
      if (oldStream.kind !== 'stream') return fail('old held stream');
      const oldReader = oldStream.body.getReader(); assert.equal((await oldReader.read()).done, false);
      const oldRow = async () => (await kernelPool.query(`SELECT effect,transport_occupied,worker,closure_token,native_origin_ref,
        engine_incarnation,request_nonce,descriptor_generation FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
      [cfg.consumer.consumerId, old.executionRef, oldId])).rows[0];
      const originalProof = await oldRow(); ensure(originalProof.transport_occupied, 'held old request occupied');
      assert.equal((await oldRow()).transport_occupied, true, 'live current engine is not old closure evidence');

      phase = 'abrupt-owned-supervisor-engine-loss';
      const childIds = readFileSync('/proc/self/task/' + process.pid + '/children', 'utf8').trim().split(/\s+/);
      ensure(childIds.length === 1 && /^[1-9][0-9]*$/.test(childIds[0]), 'sole owned Go supervisor');
      const parent = processState(childIds[0]); ensure(parent, 'captured supervisor birth');
      owned = await pinFixtureProcesses(initial.bootId, [
        { pid: childIds[0], birthTicks: parent!.birthTicks, parent: String(process.pid) },
        { pid: initial.pid, birthTicks: initial.birthTicks, parent: childIds[0] },
      ]);
      await owned.kill(); // Both retained pidfds report exit, never PID absence.
      await owned.close(); owned = undefined;
      assert.equal(await service.stopped, 'pending', 'abrupt loss has no graceful parent receipt');
      await oldReader.cancel().catch(() => undefined); service = undefined;
      assert.equal((await oldRow()).transport_occupied, true, 'death alone is not SQL closure');

      phase = 'fresh-service-automatic-old-closure';
      service = await startService(configFile); const current = service.binding;
      assert.notEqual(current.incarnation, initial.incarnation);
      const oldSelector = { originRef: initial.originRef, engineIncarnation: initial.incarnation };
      const closureDeadline = Date.now() + 45_000; let recovered = await oldRow();
      while (recovered.transport_occupied && Date.now() < closureDeadline) { await delay(100); recovered = await oldRow(); }
      // RED with the original incarnation-skipping tick. No manual kernel ACK,
      // SQL occupancy update, synthetic receipt or inference replay occurs here.
      ensure(!recovered.transport_occupied && recovered.effect === 'effect_unknown', 'automatic exact old closure via CLI and fresh cleanup CAS');
      // Current full binding is mandatory even though a positive old receipt is
      // now retained. These read-only failures must never change SQL occupancy.
      const readbackLock = await kernelPool.connect();
      try {
        await readbackLock.query('BEGIN');
        await readbackLock.query("SET LOCAL lock_timeout = '1000ms'");
        await readbackLock.query('SELECT consumer FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE', [cfg.consumer.consumerId]);
        const before = await oldRow();
        for (const bad of [{ ...current, birthTicks: String(BigInt(current.birthTicks) + 1n) },
          { ...current, bootId: randomUUID() }, { ...current, lockInode: String(BigInt(current.lockInode) + 1n) }])
          assert.equal(await composeServiceRetirementReadback(cfg.native)(bad, oldSelector, new AbortController().signal), undefined);
        assert.deepEqual(await oldRow(), before, 'wrong current binding performs no SQL closure');
      } finally { try { await readbackLock.query('ROLLBACK'); } finally { readbackLock.release(); } }
      for (const key of ['worker','closure_token','native_origin_ref','engine_incarnation','request_nonce','descriptor_generation'])
        assert.equal(recovered[key], originalProof[key], 'original immutable proof ' + key);
      const facts = (await kernelPool.query('SELECT state,request_count,max_requests,max_tokens FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2',
        [cfg.consumer.consumerId, old.executionRef])).rows[0];
      assert.equal(facts.state, 'fenced'); assert.equal(facts.request_count, 1);
      assert.equal(facts.max_requests, oldInput.limits.requests); assert.equal(facts.max_tokens, oldInput.limits.tokens);
      const cleanupRow = async () => (await kernelPool.query('SELECT state,worker,token FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=$2',
        [cfg.consumer.consumerId, old.executionRef])).rows[0];
      let cleanup = await cleanupRow(); const settlementDeadline = Date.now() + 5000;
      while (cleanup?.state !== 'done' && Date.now() < settlementDeadline) { await delay(25); cleanup = await cleanupRow(); }
      ensure(cleanup?.state === 'done' && cleanup.worker !== originalProof.worker && cleanup.token, 'current delegated cleanup settled');
      ensure(skippedRefreshTicks > 0 && !tickViolation, 'actual acquired cleanup tick skips refresh after retirement and settlement');
      // Dynamic execution bearers are intentionally local to a service lifetime;
      // remint under run-control from the SAME original persisted preparation.
      const refreshed = await run(oldInput);
      assert.equal(refreshed.executionRef, old.executionRef); assert.deepEqual(refreshed.admission, old.admission);
      assert.equal((await refreshed.client.status(old.executionRef, oldId)).effect, 'effect_unknown');
      ensure(Date.now() < Date.parse(oldInput.deadline), 'unknown replay checks precede original deadline');
      for (const requestId of [oldId, randomUUID()]) {
        try {
          const denied = await refreshed.client.request(old.executionRef, { requestId, admission: refreshed.admission, body: body(3) });
          ensure(denied.kind !== 'stream', 'unknown invocation cannot replay under old or new request ID');
        } catch (error) {
          ensure(error instanceof GatewayError && error.code === 'safe_error' && error.diagnostic?.code === 'forbidden', 'persisted unknown fence denies replay');
        }
      }
      assert.equal(calls, 3);

      phase = 'new-request-unaffected-by-old-readback';
      const next = await run(freshInput()), nextId = randomUUID();
      const nextStream = await next.client.request(next.executionRef, { requestId: nextId, admission: next.admission, body: body(4) });
      if (nextStream.kind !== 'stream') return fail('new held stream after old closure');
      const nextReader = nextStream.body.getReader(); assert.equal((await nextReader.read()).done, false);
      const valid = await composeServiceRetirementReadback(cfg.native)(current, oldSelector, new AbortController().signal);
      ensure(valid?.binding.incarnation === initial.incarnation && valid.binding.pid === initial.pid && valid.binding.birthTicks === initial.birthTicks,
        'real retained full old receipt through live current engine');
      assert.equal(await composeServiceRetirementReadback(cfg.native)({ ...current, incarnation: randomUUID() }, oldSelector,
        new AbortController().signal), undefined);
      assert.equal((await kernelPool.query('SELECT transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
        [cfg.consumer.consumerId, next.executionRef, nextId])).rows[0].transport_occupied, true, 'old/wrong binding does not close newer request');
      ensure(held.has(4), 'new upstream held'); held.get(4)!();
      const nextChunks: Uint8Array[] = []; let nextBytes = 0;
      for (;;) { const chunk = await nextReader.read(); if (chunk.done) break; nextBytes += chunk.value.length; ensure(nextBytes <= 65_536, 'new output bound'); nextChunks.push(chunk.value); }
      ensure(Buffer.concat(nextChunks).includes(Buffer.from('response.completed')), 'new request completes normally');
      assert.equal((await next.client.status(next.executionRef, nextId)).effect, 'completed');
      ensure(!violation && calls === 4, 'exact controlled entries without replay');
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
      try {
        try { if (owned) await owned.kill(); }
        finally { if (owned) await owned.close(); }
      } finally {
        await service?.stop(); held.forEach(resolve => resolve());
        PostgresKernel.prototype.claimCleanup = claimCleanup;
        AccountManagement.prototype.refreshOAuth = refreshOAuth;
        upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
        await Promise.all([kernelPool.end(), nativePool.end()]);
      }
    }
  });
