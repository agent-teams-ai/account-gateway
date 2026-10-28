import test from 'node:test';
import { ProcessRuntimeError } from 'node-or-bun';
import assert from 'node:assert/strict';
import { failureOutcome, safeFailure, QualificationFailure } from './failure.ts';
test('cleanup failure preserves original protected-path metadata and first phase', () => {
  const first = safeFailure(new QualificationFailure({ code: 'unprotected-path', step: 'install-assembly', guard: { path: '/opt', uid: 0, gid: 0, mode: '40775', symlink: false } }), 'later-step');
  const cleanup = safeFailure(new Error('pg-stop-unproven'), 'cleanup');
  assert.deepEqual(failureOutcome(first, cleanup), { primary: first, cleanup });
  assert.equal(failureOutcome(undefined, cleanup).primary, cleanup);
});
test('untrusted errors never export raw message or stack', () => {
  const result = safeFailure(new Error('provider body and private key = sensitive'), 'node');
  assert.deepEqual(result, { code: 'operator-failed', step: 'node' });
});

test('NOB failure preserves bounded process code without raw output',()=>{assert.deepEqual(safeFailure(new ProcessRuntimeError('timeout','provider body = private'),'postgres-cleanup'),{code:'process-timeout',step:'postgres-cleanup'});});
