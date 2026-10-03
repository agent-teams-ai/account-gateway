import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Regression: a logical checkout path disguises a physical in-source destination.
test('archive qualification rejects in-source destinations through a symlinked checkout', async t => {
 await mkdir('.cache/qualification-tests',{recursive:true});
 const root=await mkdtemp(resolve('.cache/qualification-tests/run-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root+'/source/inside',{recursive:true});
 await symlink(root+'/source',root+'/checkout');
 await writeFile(root+'/archive.tgz','');
 // Existing destination prevents install even if the outside-source guard regresses.
 const result=spawnSync('bash',['-c','cd "$1" && bash "$2" "$3" "$4"','qualification',
  root+'/checkout',resolve('scripts/qualify-consumers.sh'),root+'/archive.tgz',root+'/source/inside'],{encoding:'utf8'});
 assert.equal(result.status,2);
 assert.match(result.stderr,/Use a directory outside the source workspace/);
});
