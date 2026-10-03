import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const check = () => spawnSync(process.execPath, ['node_modules/@agent-teams/engineering-foundation/dist/cli.js', 'check', 'architecture.source-dependencies', '--consumer', '.', '--format', 'json'], { encoding: 'utf8' });
// Regression: type-only SDK/framework imports bypass the actual installed source policy.
test('valid source profile passes and prohibited type-only import fails', () => {
  const valid = check(); assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const file = 'packages/account-gateway/src/features/facade-client/contracts/forbidden-policy-fixture.ts';
  try {
    writeFileSync(file, "import type { ModuleDeclaration } from '@get-modular/core';\nexport type Forbidden = ModuleDeclaration;\n");
    const invalid = check(); assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).outcome, 'violations');
    writeFileSync(file, "import type { FoundationConfig } from '@agent-teams/engineering-foundation';\nexport type Forbidden = FoundationConfig;\n");
    const devOnly=check(); assert.equal(devOnly.status,1,devOnly.stdout+devOnly.stderr);
  } finally { unlinkSync(file); }
});

// Regression: module composition bypasses a feature's curated public entrypoint.
test('composition cannot deep-import feature HTTP internals', () => {
 const file='packages/account-gateway/src/get-modular/deep-import-fixture.ts';
 try {
  writeFileSync(file,"import { connect } from '../features/facade-client/http/ingress.js';\nexport const forbidden = connect;\n");
  const invalid=check();assert.equal(invalid.status,1,invalid.stdout+invalid.stderr);
 } finally { unlinkSync(file); }
});

// Regression: a database/framework dependency enters the private policy domain.
test('private kernel domain rejects a type-only database import', () => {
 const file='services/account-gateway/src/domain.ts';
 const original=readFileSync(file,'utf8');
 try {
  writeFileSync(file,original+"\nimport type { Pool } from 'pg';\nexport type ForbiddenKernelDependency = Pool;\n");
  const invalid=check();assert.equal(invalid.status,1,invalid.stdout+invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).outcome,'violations');
 } finally { writeFileSync(file,original); }
});
