import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { docsInitPlan, docsInitApply, docsCheckV2, docsNewV2 } from '@agent-teams/docs-protocol';
const digest = data => createHash('sha256').update(data).digest('hex');
async function snapshot(root, prefix='') {
  const result={};
  for(const entry of await readdir(root,{withFileTypes:true})) {
    const name=prefix+entry.name;
    if(entry.isDirectory()) Object.assign(result,await snapshot(root+'/'+entry.name,name+'/'));
    else result[name]=digest(await readFile(root+'/'+entry.name));
  }
  return result;
}
async function fresh() { await mkdir('.cache/docs-tests',{recursive:true});return mkdtemp(resolve('.cache/docs-tests/run-')); }
// Regression: a changed reviewed preimage mutates independent instructions or creates docs anyway.
test('installed portable init refuses a changed preimage with zero file mutation', async () => {
 const root=await fresh(); const input={consumerRoot:root,ownerId:'gateway-maintainers',projectId:'docs-fixture'};
 const plan=await docsInitPlan(input);
 await writeFile(root+'/AGENTS.md','# Independent instructions\n');
 const before=await snapshot(root);
 await assert.rejects(docsInitApply({...input,expectedPlanDigest:plan.planDigest}));
 assert.deepEqual(await snapshot(root),before);
});
// Regression: portable v4 relation policy accepts an absent blocker or an incompatible terminal state.
test('tiny portable v4/authoring v3 corpus validates and rejects broken relations', async () => {
 const root=await fresh(); await cp('docs/corpus',root,{recursive:true});
 const base={consumerRoot:root,profilePath:'docs.config.yaml'};
 assert.equal((await docsCheckV2(base)).exitCode,0);
 const file=root+'/docs/reference/sdk-boundary.md';
 const original=await readFile(file,'utf8');
 await writeFile(file,original.replace('status: proposed','status: active\nrelated: [docs.reference.absent]\nblocked_by: [docs.reference.absent]'));
 const invalid=await docsCheckV2(base); assert.notEqual(invalid.exitCode,0);
 assert.ok(invalid.envelope.diagnostics.some(d=>d.severity==='error'));
});
// Regression: applying a new document against changed authoring authority bypasses reviewed Plan bytes.
test('new document preview rejects changed authoring authority without publication', async () => {
 const root=await fresh(); await cp('docs/corpus',root,{recursive:true});
 const request={consumerRoot:root,profilePath:'docs.config.yaml',apply:false,intent:{type:'reference',id:'docs.reference.preview',title:'Preview',owner:'gateway-maintainers',summary:'Disposable authority test.'}};
 const preview=await docsNewV2(request); assert.equal(preview.exitCode,0);
 const profile=root+'/.docs-protocol/document-authoring.yaml';
 await writeFile(profile,(await readFile(profile,'utf8')).replace('provide reachability','supply reachability'));
 const before=await snapshot(root);
 const applied=await docsNewV2({...request,apply:true,expectedPlanDigest:preview.envelope.result.planDigest});
 assert.equal(applied.envelope.outcome,'authority-stale');
 assert.deepEqual(await snapshot(root),before);
});

async function repositoryCorpus() {
 const root=await fresh();
 for(const path of ['docs','packages/account-gateway/README.md','README.md','AGENTS.md','docs.config.yaml','.docs-protocol'])
   await cp(path,root+'/'+path,{recursive:true});
 return root;
}
// Regression: the actual governed repository docs accept conflicting metadata.
test('repository authored docs validate from the unchanged production profile', async () => {
 const root=await repositoryCorpus();const base={consumerRoot:root,profilePath:'docs.config.yaml'};
 const checked=await docsCheckV2(base);assert.equal(checked.exitCode,0,JSON.stringify(checked.envelope));
 await writeFile(root+'/docs/first-slice.md','---\nid: conflicting.identity\n---\n# Changed\n');
 const invalid=await docsCheckV2(base);assert.notEqual(invalid.exitCode,0);
});
// Regression: root authoring workflow cannot publish a reviewed document or ignores changed authority.
test('repository preview/apply publishes only the exact reviewed authoring plan', async () => {
 const root=await repositoryCorpus();
 const request={consumerRoot:root,profilePath:'docs.config.yaml',apply:false,intent:{type:'reference',id:'docs.reference.real-preview',title:'Real preview',owner:'gateway-maintainers',summary:'Disposable repository authoring test.'}};
 const preview=await docsNewV2(request);assert.equal(preview.exitCode,0,JSON.stringify(preview.envelope));
 const applied=await docsNewV2({...request,apply:true,expectedPlanDigest:preview.envelope.result.planDigest});
 assert.equal(applied.exitCode,0,JSON.stringify(applied.envelope));
 assert.equal((await docsCheckV2({consumerRoot:root,profilePath:'docs.config.yaml'})).exitCode,0);
 const second={...request,intent:{...request.intent,id:'docs.reference.stale-preview',title:'Stale preview'}};
 const plan=await docsNewV2(second);assert.equal(plan.exitCode,0);
 const sidecar=root+'/.docs-protocol/metadata.yaml';
 await writeFile(sidecar,(await readFile(sidecar,'utf8')).replace('Accepted first-slice','Reviewed first-slice'));
 const before=await snapshot(root);
 const stale=await docsNewV2({...second,apply:true,expectedPlanDigest:plan.envelope.result.planDigest});
 assert.equal(stale.envelope.outcome,'authority-stale');
 assert.deepEqual(await snapshot(root),before);
});
