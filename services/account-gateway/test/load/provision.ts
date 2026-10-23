// Disposable root operator. Network isolation is an independently checked
// prerequisite; workload and assertion authority remain in stand.ts.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { bounds, check, scenarios } from './model.ts';
import { sha256 } from './fixture.ts';
import type { Fixture } from './fixture.ts';
import { nativeSourceCommit, migrationAdapterSource } from './build-native-fixture.ts';

const captured = new Set<ChildProcess>();
type Stage = 'arguments' | 'network' | 'build_receipt' | 'postgres_version' | 'source' | 'layout' |
  'tls' | 'trust' | 'postgres_init' | 'postgres_start' | 'database_create' | 'native_migrations' |
  'fixture_manifest' | 'workload' | 'summary' | 'postgres_stop' | 'trust_restore' | 'artifact_copy';
let stage: Stage = 'arguments';
// Keep the process-group leader alive until it disposes its own group. An
// exited leader's numeric PID is never reused as a later signal target.
const custody = `const {spawn}=require('node:child_process');
const dispose=()=>process.kill(-process.pid,'SIGKILL');
process.on('SIGTERM',dispose);process.on('SIGINT',dispose);process.on('disconnect',dispose);
const child=spawn(process.argv[1],process.argv.slice(2),{env:process.env,stdio:['ignore','inherit','inherit']});
child.once('error',()=>process.send({kind:'result',code:1}));
child.once('close',code=>process.send({kind:'result',code}));
setInterval(()=>{},1000);`;
let requestedStop = false;
const terminate = () => { requestedStop = true; for (const child of captured) child.kill('SIGTERM'); };
process.once('SIGTERM', terminate); process.once('SIGINT', terminate);

async function command(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv;
  uid?: number; gid?: number; timeout?: number; group?: boolean; log?: string } = {}): Promise<string> {
  check(!requestedStop, 'operator-stopping');
  const common = { cwd: options.cwd ?? '/', env: options.env ?? {}, uid: options.uid, gid: options.gid };
  const child = options.group
    ? spawn(process.execPath, ['-e', custody, executable, ...args], { ...common, detached: true, stdio: ['ignore','pipe','pipe','ipc'] })
    : spawn(executable, args, { ...common, detached: false, stdio: ['ignore','pipe','pipe'] });
  captured.add(child);
  let output = '', diagnostics = '', bytes = 0, overflow = false;
  const collect = (data: Buffer, stdout: boolean) => {
    bytes += data.length;
    if (bytes > 1_048_576) { overflow = true; child.kill(options.group ? 'SIGTERM' : 'SIGKILL'); }
    else { const text = data.toString('utf8'); if (stdout) output += text; diagnostics += text; }
  };
  child.stdout!.on('data', data => collect(data, true)); child.stderr!.on('data', data => collect(data, false));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  const timer = setTimeout(() => child.kill(options.group ? 'SIGTERM' : 'SIGKILL'), options.timeout ?? 60_000);
  const result = options.group ? Promise.race([closed.then(() => 1), new Promise<number | null>(resolve => {
    child.once('message', value => {
      const message = value as { kind?: unknown; code?: unknown };
      resolve(message.kind === 'result' && (message.code === null || Number.isInteger(message.code)) ? message.code as number | null : 1);
    });
  })]) : closed;
  const code = await result.finally(async () => {
    clearTimeout(timer);
    if (options.group && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([closed.catch(() => undefined), delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    captured.delete(child);
  });
  if (options.log) writeFileSync(options.log, diagnostics, { mode: 0o600 });
  check(code === 0 && !overflow && !requestedStop, 'operator-command-failed');
  return output.trim();
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); check(address && typeof address !== 'string', 'operator-port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function networkEvidence(requireBackpressureProfile: boolean): Promise<Record<string, string | boolean | number>> {
  const links = readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2).map(line => line.split(':')[0].trim());
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
  check(links.length === 1 && links[0] === 'lo' && routes.length === 0, 'operator-network-isolation-required');
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '192.0.2.1', port: 443 });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('load:operator-external-probe-timeout')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('load:operator-external-connectivity')); });
    socket.once('error', error => { socket.destroy(); if ('code' in error && error.code === 'ENETUNREACH') resolve(); else reject(new Error('load:operator-external-probe')); });
  });
  const tcpReceiveMemory = readFileSync('/proc/sys/net/ipv4/tcp_rmem', 'utf8').trim().split(/\s+/).join(' ');
  const tcpSendMemory = readFileSync('/proc/sys/net/ipv4/tcp_wmem', 'utf8').trim().split(/\s+/).join(' ');
  const tcpReceiveAutotuning = readFileSync('/proc/sys/net/ipv4/tcp_moderate_rcvbuf', 'utf8').trim();
  // A multi-hop pipeline with a 32-MiB autotuned receiver can absorb the entire
  // qualified 8-MiB stream. The bounded experiment needs an explicit private
  // network-namespace profile, configured by the container operator, not here.
  if (requireBackpressureProfile) check(tcpReceiveMemory === '4096 16384 65536' &&
    tcpSendMemory === '4096 16384 65536' && tcpReceiveAutotuning === '0', 'operator-backpressure-profile-required');
  return { interfaces: 'lo only', ipv4Routes: 'none', externalProbe: '192.0.2.1:443 ENETUNREACH',
    tcpReceiveMemory, tcpSendMemory, tcpReceiveAutotuning };
}

async function main() {
  const options = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    check(['--repo','--build-receipt','--pg-bin','--artifacts','--suite','--seed','--trust-mode','--gateway-commit'].includes(key) && value && !options.has(key), 'operator-arguments');
    options.set(key, value);
  }
  const repo = options.get('--repo'), receiptPath = options.get('--build-receipt'), pgBin = options.get('--pg-bin'), destination = options.get('--artifacts');
  const suite = options.get('--suite') ?? 'smoke', trustMode = options.get('--trust-mode') ?? 'bind', seed = Number(options.get('--seed') ?? 20261023);
  check(process.platform === 'linux' && process.geteuid?.() === 0 && ['v26.11.1','v24.21.0'].includes(process.version), 'operator-runtime');
  check(repo && receiptPath && pgBin && destination && [repo, receiptPath, pgBin, destination].every(isAbsolute), 'operator-absolute-paths');
  check((suite === 'all' || scenarios.some(name => name === suite)) && ['bind','container'].includes(trustMode) && Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'operator-options');
  if (trustMode === 'container') check(existsSync('/.dockerenv'), 'operator-disposable-container-required');
  stage = 'network'; const network = await networkEvidence(suite === 'all' || suite === 'slow-reader');
  stage = 'build_receipt';
  const build = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, string>;
  check(build.kind === 'native-fullstack-build-v1' && build.sourceCommit === nativeSourceCommit &&
    build.goVersion === 'go1.27.3' && build.migrationAdapterSha256 === sha256(migrationAdapterSource), 'operator-native-build-receipt');
  const sourceBinary = join(dirname(receiptPath), 'account-gateway-native'), sourceMigrator = join(dirname(receiptPath), 'native-fixture-migrate');
  check(sha256(readFileSync(sourceBinary)) === build.sha256 && sha256(readFileSync(sourceMigrator)) === build.migratorSha256, 'operator-native-build-hashes');
  stage = 'postgres_version';
  const version = await command(join(pgBin, 'postgres'), ['--version']); check(/^postgres \(PostgreSQL\) 17\.10(?:$| )/.test(version), 'operator-pg-17-10');
  stage = 'source';
  const gatewayCommit = options.get('--gateway-commit') ?? await command('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD']);
  check(/^[a-f0-9]{40}$/.test(gatewayCommit), 'operator-gateway-commit');
  stage = 'layout';
  mkdirSync(destination, { recursive: true, mode: 0o700 }); check(readdirSync(destination).length === 0, 'operator-fresh-artifacts');
  // Go drops UID before exec: its root-owned image needs traversable ancestors.
  // Bootstrap, authority, TLS keys and evidence remain in private sibling dirs.
  const runId = randomUUID(), owned = mkdtempSync('/opt/ag_load_operator_'), root = join(owned, 'fixture'), artifacts = join(owned, 'artifacts');
  chmodSync(owned, 0o755); mkdirSync(root, { mode: 0o700 }); mkdirSync(artifacts, { mode: 0o700 });
  const nativeDir = join(owned, 'native'), tls = join(root, 'tls'); mkdirSync(nativeDir, { mode: 0o755 }); mkdirSync(tls, { mode: 0o700 });
  const executable = join(nativeDir, 'account-gateway'), migrator = join(owned, 'native-fixture-migrate');
  copyFileSync(sourceBinary, executable); chmodSync(executable, 0o755); copyFileSync(sourceMigrator, migrator); chmodSync(migrator, 0o700);
  const pgRoot = mkdtempSync('/tmp/ag_load_pg_'), data = join(pgRoot, 'data'), socket = join(pgRoot, 'socket');
  chmodSync(pgRoot, 0o755); mkdirSync(data, { mode: 0o700 }); mkdirSync(socket, { mode: 0o700 });
  chownSync(data, 65534, 65534); chownSync(socket, 65534, 65534);
  const pgLog = join(pgRoot, 'postgres.log'); writeFileSync(pgLog, '', { mode: 0o600 }); chownSync(pgLog, 65534, 65534);
  const env = { PATH: pgBin + ':/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  const caBundle = '/etc/ssl/certs/ca-certificates.crt';
  let originalCA: Buffer | undefined, mountedCA = false, pgStarted = false, success = false, failure: string | undefined, failureStage: Stage | undefined;
  try {
    stage = 'tls';
    const ca = join(tls, 'server.crt'), key = join(tls, 'server.key');
    await command('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout', key,
      '-out', ca, '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);
    chmodSync(ca, 0o644); chmodSync(key, 0o600);
    stage = 'trust';
    if (trustMode === 'bind') {
      await command('/usr/bin/mount', ['--bind', ca, caBundle]); mountedCA = true;
      await command('/usr/bin/mount', ['-o','remount,bind,ro', ca, caBundle]);
    } else { originalCA = readFileSync(caBundle); writeFileSync(caBundle, readFileSync(ca)); }
    stage = 'postgres_init';
    await command(join(pgBin, 'initdb'), ['-D', data, '--username=postgres','--auth=trust','--no-locale','--encoding=UTF8'], { env, uid: 65534, gid: 65534 });
    const port = await freePort();
    writeFileSync(join(data, 'postgresql.auto.conf'), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${socket}'\nmax_connections=200\nshared_buffers='128MB'\nfsync=on\nsynchronous_commit=on\nfull_page_writes=on\ntimezone='UTC'\n`, { mode: 0o600 });
    chownSync(join(data, 'postgresql.auto.conf'), 65534, 65534);
    stage = 'postgres_start'; pgStarted = true; // A failed/aborted start may still have created PostgreSQL.
    await command(join(pgBin, 'pg_ctl'), ['-D', data, '-l', pgLog, '-w','start'], { env, uid: 65534, gid: 65534 });
    stage = 'database_create';
    const kernelName = 'ag_load_kernel_' + randomUUID().replaceAll('-', ''), nativeName = 'ag_load_native_' + randomUUID().replaceAll('-', '');
    for (const name of [kernelName, nativeName]) await command(join(pgBin, 'createdb'), ['-h','127.0.0.1','-p', String(port), '-U','postgres', name], { env });
    const kernelDSN = `postgresql://postgres@127.0.0.1:${port}/${kernelName}`, nativeDSN = `postgresql://postgres@127.0.0.1:${port}/${nativeName}`;
    stage = 'native_migrations';
    const migration = JSON.parse(await command(migrator, [nativeDSN + '?sslmode=disable'], { env, timeout: 240_000 })) as {
      kind: string; sourceCommit: string; postgresVersion: string; accounts: number; migrationsSha256: string;
      migrations: { filename: string; sha256: string }[] };
    check(migration.kind === 'production-native-migration-receipt-v1' && migration.sourceCommit === nativeSourceCommit &&
      migration.postgresVersion.startsWith('17.10') && migration.accounts === 0, 'operator-native-migrations');
    stage = 'fixture_manifest';
    const fixture: Fixture = { kind: 'account-gateway-fullstack-fixture-v1', runId, seed, root, artifacts, kernelDSN, nativeDSN: nativeDSN + '?sslmode=disable', gatewayCommit,
      native: { executable, sha256: build.sha256, sourceCommit: nativeSourceCommit, migrationsSha256: migration.migrationsSha256,
        migrationFiles: migration.migrations.map(x => ({ name: x.filename, sha256: x.sha256 })) },
      tls: { ca, cert: ca, key }, network: { externalDisabled: true, evidence: network } };
    const manifest = join(root, 'fixture.json'); writeFileSync(manifest, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
    writeFileSync(join(artifacts, 'native-migrations.json'), JSON.stringify(migration, null, 2) + '\n', { mode: 0o600 });
    stage = 'workload';
    await command(process.execPath, ['--test','--test-isolation=none','--test-reporter=tap', join(repo, 'services/account-gateway/test/load/stand.ts')],
      { cwd: repo, env: { ...env, NODE_USE_SYSTEM_CA: '1', AG_LOAD_MANIFEST: manifest, ...(suite === 'all' ? {} : { AG_LOAD_SCENARIOS: suite }) },
        group: true, timeout: bounds.wallMs + 60_000, log: join(owned, 'stand.log') });
    stage = 'summary';
    const summary = JSON.parse(readFileSync(join(artifacts, 'summary.json'), 'utf8')) as Record<string, unknown>;
    check(summary.outcome === 'pass' && summary.ledgerMatches === true && summary.sourceUnchanged === true && summary.sdkArtifactUnchanged === true && summary.stopped === 'retired' &&
      JSON.stringify(summary.expectedScenarios) === JSON.stringify(suite === 'all' ? scenarios : [suite]), 'operator-qualification-summary');
    success = true;
  } catch (error) { failureStage = stage; failure = error instanceof Error && /^load:[a-z0-9-]+$/.test(error.message) ? error.message.slice(5) : 'operator-failed'; }
  finally {
    requestedStop = false; // Cleanup remains required after an operator signal.
    if (pgStarted) {
      try { await command(join(pgBin, 'pg_ctl'), ['-D', data, '-m','fast','-w','stop'], { env, uid: 65534, gid: 65534, timeout: 30_000 }); }
      catch { success = false; failure ??= 'operator-pg-stop'; failureStage ??= 'postgres_stop'; }
    }
    for (const child of captured) child.kill('SIGTERM');
    await delay(100);
    for (const child of captured) child.kill('SIGKILL');
    if (mountedCA) {
      try { await command('/usr/bin/umount', [caBundle]); } catch { success = false; failure ??= 'operator-ca-unmount'; failureStage ??= 'trust_restore'; }
    }
    if (originalCA) { try { writeFileSync(caBundle, originalCA); } catch { success = false; failure ??= 'operator-ca-restore'; failureStage ??= 'trust_restore'; } }
    const receipt = { kind: 'fullstack-operator-result-v1', runId, seed, node: process.version, suite, outcome: success ? 'pass' : 'fail',
      failure, failureStage, nativeSourceCommit, nativeSha256: build.sha256, migratorSha256: build.migratorSha256,
      migrationAdapterSha256: build.migrationAdapterSha256, gatewayCommit, network, postgresVersion: version };
    writeFileSync(join(artifacts, 'operator-result.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    stage = 'artifact_copy';
    for (const name of ['operator-result.json','summary.json','source-manifest.json','native-migrations.json','attempts.json','preparations.json','cleanup.json','scenarios.json','provider-ledger.ndjson','resources.json']) {
      const path = join(artifacts, name);
      if (existsSync(path)) { check(statSync(path).isFile() && statSync(path).size <= bounds.artifactBytes, 'operator-artifact-bound'); copyFileSync(path, join(destination, name)); chmodSync(join(destination, name), 0o600); }
    }
    rmSync(pgRoot, { recursive: true, force: true }); rmSync(owned, { recursive: true, force: true });
  }
  if (failureStage) stage = failureStage;
  check(success, 'operator-qualification-failed');
  process.stdout.write(JSON.stringify({ outcome: 'pass', runId, suite, node: process.version, artifacts: destination }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ event: 'fullstack_operator_failure', stage,
      code: error instanceof Error && /^load:[a-z0-9-]+$/.test(error.message) ? error.message.slice(5) : 'operator-failed' }) + '\n');
    process.exitCode = 1;
  });
}
