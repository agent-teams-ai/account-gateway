import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('operator rejects unsupported trust modes before any fixture provisioning', () => {
  const root = mkdtempSync('/tmp/ag-load-mode-');
  try {
    for (const mode of ['bind', 'host']) {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('./provision.ts', import.meta.url)),
        '--repo', join(root, 'source'), '--build-receipt', join(root, 'build.json'),
        '--pg-bin', join(root, 'postgres'), '--artifacts', join(root, 'artifacts'), '--trust-mode', mode],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.equal(child.signal, null);
      assert.equal(child.stdout, '');
      const events = child.stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.deepEqual(events, [{ event: 'fullstack_operator_failure', stage: 'arguments', code: 'operator-container-only' }]);
      assert.deepEqual(readdirSync(root), [], 'an unsupported mode cannot create an artifact directory or fixture');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
