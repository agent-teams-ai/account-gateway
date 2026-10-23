// Capture raw Go diagnostics only in memory; CI receives the same safe evidence
// schema as the private-network process fixture, including on test failure.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { bootstrapTests, goTestEvidence, publicTests, reservationTests } from './evidence.ts';

const [source, artifacts] = process.argv.slice(2);
if (!source || !artifacts || !isAbsolute(source) || !isAbsolute(artifacts) || process.argv.length !== 4) {
  process.stderr.write('native-race-arguments\n'); process.exitCode = 1;
} else {
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  for (const lane of [
    { file: 'public-race.json', pkg: './internal/gatewaytransport', pattern: '^(TestPublic|TestStandardResponses|TestBoundReservation|TestClaudePrivate)', names: publicTests },
    { file: 'reservation-race.json', pkg: './internal/gatewaytransport', pattern: '^(TestNEWTEST|TestGatewayNativeUsageReceipt$|TestGatewayNativeOwnerHTTPClosureOnActualCompletedTransport$)', names: reservationTests },
    { file: 'bootstrap-race.json', pkg: './internal/gatewaybootstrap', pattern: '^TestPublic', names: bootstrapTests },
  ]) {
    const child = spawnSync('go', ['test', '-race', '-tags', 'unit', lane.pkg, '-run', lane.pattern, '-count=1', '-v', '-timeout', '180s'],
      { cwd: source, encoding: 'utf8', timeout: 600_000, maxBuffer: 4_194_304 });
    const raw = (child.stdout ?? '') + '\n' + (child.stderr ?? '');
    const evidence = goTestEvidence(raw, lane.names);
    const passed = new Set(evidence.tests.filter(t => t.outcome === 'PASS').map(t => t.name));
    const success = child.status === 0 && !child.error && !raw.includes('--- SKIP:') && !raw.includes('no tests to run') && lane.names.every(name => passed.has(name));
    const report = { ...evidence, outcome: success ? 'pass' : 'fail', exitCode: child.status, interrupted: !!child.signal, commandFailed: !!child.error };
    const safe = JSON.stringify(report, null, 2) + '\n';
    writeFileSync(join(artifacts, lane.file), safe, { mode: 0o600 }); process.stdout.write(safe);
    if (!success) { process.exitCode = 1; break; }
  }
}
