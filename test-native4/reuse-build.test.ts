import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectPin, validateProvider } from './reuse-build.ts';
const inputs=JSON.parse(readFileSync(new URL('./reuse-inputs.json',import.meta.url),'utf8'));
test('immutable source artifact rejects wrong run, source, repo, digest and expiry',()=>{
  const pin=selectPin('24.21.0');const meta={id:pin.id,name:pin.name,size_in_bytes:pin.size,digest:'sha256:'+pin.sha256,expired:false,workflow_run:{id:inputs.producerRun,head_sha:inputs.producerOverlay,repository_id:inputs.repositoryId,head_repository_id:inputs.repositoryId}};
  assert.doesNotThrow(()=>validateProvider(meta,'24.21.0'));
  for(const altered of [{...meta,id:1},{...meta,digest:'sha256:'+'0'.repeat(64)},{...meta,expired:true},{...meta,workflow_run:{...meta.workflow_run,id:1}},{...meta,workflow_run:{...meta.workflow_run,head_sha:'0'.repeat(40)}},{...meta,workflow_run:{...meta.workflow_run,repository_id:1}}])assert.throws(()=>validateProvider(altered,'24.21.0'),/reuse-provider-binding/);
  assert.throws(()=>selectPin('latest'),/reuse-node/);
});
