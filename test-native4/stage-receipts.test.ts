import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReceipt } from './stage-receipts.ts';
test('only safe receipt envelopes are staged; configuration fields and oversized data refuse',()=>{
  const safe={outcome:'fail',phase:'runtime',primary:{code:'unprotected-path',step:'install-assembly',guard:{path:'/opt',uid:0,gid:0,mode:'40775',symlink:false}}};
  assert.doesNotThrow(()=>validateReceipt('failure.json',Buffer.from(JSON.stringify(safe))));
  assert.throws(()=>validateReceipt('failure.json',Buffer.from(JSON.stringify({...safe,serviceConfig:{keys:'private'}}))),/receipt-schema/);
  assert.throws(()=>validateReceipt('failure.json',Buffer.from(JSON.stringify({...safe,primary:{...safe.primary,credential:'private'}}))),/receipt-private-field/);
  assert.throws(()=>validateReceipt('cleanup.json',Buffer.from(JSON.stringify(safe))),/receipt-schema|receipt-kind/);
  assert.throws(()=>validateReceipt('runtime.json',Buffer.alloc(524289)),/receipt-size/);
});
