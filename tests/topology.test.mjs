import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// Regression: an unowned SDK file, undeclared module or empty ceremonial layer is released.
test('scoped topology rejects unowned behavior, modules and empty feature layers', async () => {
  await mkdir('.cache/topology-tests', {recursive:true});
  const root = await mkdtemp(resolve('.cache/topology-tests/run-'));
  await cp('packages/account-gateway/src', root+'/packages/account-gateway/src', {recursive:true});
  await cp('architecture', root+'/architecture', {recursive:true});
  const check=()=>spawnSync(process.execPath,['scripts/check-topology.mjs',root],{encoding:'utf8'});
  assert.equal(check().status,0);
  const file=root+'/packages/account-gateway/src/rogue.ts';
  await writeFile(file,'export const unowned = 1;\n');assert.equal(check().status,1);await rm(file);
  const layer=root+'/packages/account-gateway/src/features/facade-client/domain';
  await mkdir(layer);assert.equal(check().status,1);await rm(layer,{recursive:true});
  await mkdir(root+'/packages/undeclared');assert.equal(check().status,1);
});
