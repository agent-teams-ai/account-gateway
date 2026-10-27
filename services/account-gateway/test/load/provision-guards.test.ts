import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childFailureFacts } from './provision.ts';

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

test('operator failure facts retain only capped sanitized native response records including TAP-prefixed lines', () => {
  const response = { event: 'gateway_native_response_failure', phase: 'transport',
    transport_error_reason: 'connection_reset', upstream_connection: 'reused',
    upstream_request_written: false, upstream_response_started: false, native_entered: true };
  const lines = [
    'private-provider-prompt Bearer private-access-token',
    '# ' + JSON.stringify(response),
    '    # ' + JSON.stringify({ ...response, transport_error_reason: 'connection_refused', upstream_connection: 'new' }),
    JSON.stringify({ event: 'gateway_native_response_failure', phase: 'body_read' }),
    JSON.stringify({ event: 'gateway_native_response_failure', phase: 'transport', error: 'private-error-body' }),
    JSON.stringify({ ...response, transport_error_reason: 'private-error-token' }),
    JSON.stringify({ ...response, upstream_connection: 'private-hostname' }),
    JSON.stringify({ ...response, upstream_request_written: 'private-output' }),
    JSON.stringify({ event: 'gateway_native_oauth_connect_failure', phase: 'exchange_transport' }),
    ...Array.from({ length: 12 }, () => '# ' + JSON.stringify(response)),
  ].join('\n') + '\n';
  const facts = childFailureFacts(lines, { exitCode: 1, timedOut: false, outputOverflow: false });
  assert.equal(facts.nativeResponseFailures.length, 8);
  assert.deepEqual(facts.nativeResponseFailures.slice(0, 3), [response,
    { ...response, transport_error_reason: 'connection_refused', upstream_connection: 'new' },
    { event: 'gateway_native_response_failure', phase: 'body_read' }]);
  assert.equal(JSON.stringify(facts).includes('private-'), false);
  assert.equal(JSON.stringify(facts).includes('oauth'), false);
  const empty = childFailureFacts('private-oauth-only', { exitCode: 1, timedOut: false, outputOverflow: false });
  assert.deepEqual(empty.nativeResponseFailures, []);
});
test('operator native diagnostics reject incomplete records and remain inside the existing one-megabyte input cap', () => {
  const response = JSON.stringify({ event: 'gateway_native_response_failure', phase: 'transport' });
  const status = { exitCode: 1, timedOut: false, outputOverflow: false };
  assert.deepEqual(childFailureFacts(response, status).nativeResponseFailures, []);
  assert.deepEqual(childFailureFacts('x'.repeat(1_048_576) + '\n' + response + '\n', status).nativeResponseFailures, []);
});
