// The joined drivers may hold assertions, OAuth data and client output in
// memory. Export only independently checked provenance and fixed proof fields.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type JoinedClient = 'claude' | 'codex';
export const joinedFiles = Object.freeze({
  claudeHarness: 'services/account-gateway/test/native-claude-joined.ts',
  claudeFixture: 'services/account-gateway/test/fixtures/native-claude-joined/main.go',
  codexHarness: 'services/account-gateway/test/native-device-joined.ts',
  codexFixture: 'services/account-gateway/test/fixtures/native-device-joined/main.go',
  sdkHTTP: 'packages/account-gateway/dist/http/index.js',
});
export const digestFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function joinedSourceHashes(repo: string): Record<string, string> {
  const hashes = Object.fromEntries(Object.entries(joinedFiles).map(([key, path]) => [key, digestFile(join(repo, path))]));
  const tree = createHash('sha256');
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(repo, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === 'node_modules') continue;
      const path = relative + '/' + entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) tree.update(path + '\0' + digestFile(join(repo, path)) + '\n');
      else throw new Error('joined-source-shape');
    }
  };
  for (const relative of ['services/account-gateway/src', 'packages/account-gateway/src', 'packages/account-gateway/dist']) walk(relative);
  return { ...hashes, runtimeTree: tree.digest('hex') };
}
const check = (value: unknown) => { if (!value) throw new Error('joined-proof-invalid'); };
export function joinedReceipt(raw: string, client: JoinedClient, expected: {
  nativeCommit: string; gatewayCommit: string; binarySHA256: string; version: string; clientSHA256: string;
  sourceHashes: Record<string, string>;
}) {
  const lines = raw.trim().split(/\r?\n/); check(lines.length === 1 && lines[0].length <= 16_384);
  let r: Record<string, any>;
  try { r = JSON.parse(lines[0]); } catch { throw new Error('joined-proof-invalid'); }
  const contract = client === 'claude' ? 'gateway-native-claude-joined/v1' : 'gateway-native-device-joined/v1';
  check(r && r.phase === 'completed' && r.contract === contract && r.nativeHead === expected.nativeCommit &&
    r.gatewayHead === expected.gatewayCommit && r.nativeBinarySHA256 === expected.binarySHA256);
  const sources = { harness: expected.sourceHashes[client + 'Harness'], nativeFixture: expected.sourceHashes[client + 'Fixture'], sdkHTTP: expected.sourceHashes.sdkHTTP };
  check(r.sourceHashes && Object.entries(sources).every(([key, value]) => r.sourceHashes[key] === value));
  const a = r.actualCLI;
  check(a && a.id === client && a.version === expected.version && a.binarySHA256 === expected.clientSHA256 &&
    a.exitCode === 0 && a.providerEntries === 1 && a.sqlEffect === 'completed' && a.nativeClosed === true &&
    a.nativeAcknowledged === true && a.transportOccupied === false && a.usageRecorded === true && a.executionClosed === true);
  check((client === 'claude' ? a.terminalWaitedForDurability : a.terminalWithheldUntilDurable) === true);
  return { contract, phase: 'completed', nativeHead: expected.nativeCommit, gatewayHead: expected.gatewayCommit,
    nativeBinarySHA256: expected.binarySHA256, sourceHashes: sources,
    actualCLI: { id: client, version: expected.version, binarySHA256: expected.clientSHA256, exitCode: 0,
      providerEntries: 1, sqlEffect: 'completed', nativeClosed: true, nativeAcknowledged: true,
      transportOccupied: false, usageRecorded: true, executionClosed: true, terminalWithheldUntilDurable: true } };
}
export function joinedFailure(raw: string) {
  const phases = new Set([
    'guard', 'pinned-client-and-network', 'native-binary-input', 'native-build-provenance',
    'native-clean-build-provenance', 'gateway-source-provenance', 'gateway-scratch',
    'native-start', 'kernel-database-guard', 'kernel-migrations', 'fresh-browser-handoff',
    'owner-and-method-boundary', 'authorized-native-custody-and-descriptor', 'missing-cached-limits',
    'actual-messages-dispatch-produces-observation', 'real-cli-public-authority',
    'terminal-withheld-before-real-usage-and-ack', 'real-durable-terminal-usage-and-physical-closure',
    'real-execution-cleanup', 'passive-cached-limits', 'native-close', 'fresh-device-handoff',
    'owner-boundary', 'pending-provider-poll', 'duplicate-and-readback-no-replay',
    'cached-native-account-limits', 'actual-codex-cli-through-real-authority', 'actual-codex-cli-cleanup',
  ]);
  let at = 'driver', frame: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.length > 16_384) continue;
    try {
      const value = JSON.parse(line);
      if (value?.phase !== 'failed') continue;
      if (typeof value.at === 'string' && phases.has(value.at)) at = value.at;
      if (typeof value.frame === 'string' && /^native-(claude|device)-joined\.ts:[0-9]{1,6}:[0-9]{1,6}$/.test(value.frame)) frame = value.frame;
    } catch { /* Never reflect arbitrary child output. */ }
  }
  return { code: 'joined-driver-failed', at, ...(frame ? { frame } : {}) };
}
