import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diagnoseNode, frames, testFiles } from './node-diagnostics.ts';
import type { Source } from './node-diagnostics.ts';
const file=testFiles[0],text='test("source-known assertion", () => {\n  assert.equal(actual, expected);\n});\n';
const source:Source={file,absolute:'/owned/gateway/'+file,text,sha256:createHash('sha256').update(text).digest('hex')};
const args=['--test','--test-reporter=tap',file];
const block=(actual:string,expected:string)=>`TAP version 13
not ok 1 - source-known assertion
  ---
  location: '${source.absolute}:1:1'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  operator: 'strictEqual'
  actual: ${actual}
  expected: ${expected}
  stack: |-
    TestContext.<anonymous> (${source.absolute}:2:3)
    ignored (/private/credentials.ts:1:1)
  ...
1..1
# tests 1
# pass 0
# fail 1
# skipped 0
# todo 0
`;
test('exact invocation, source-known name/location, code/operator and validated frames retain numeric diagnosis',()=>{
  const result=diagnoseNode('/opt/node/bin/node',args,block('2','3'),'',[source],[]);assert.ok(result);
  assert.deepEqual(result.argv,['/opt/node/bin/node',...args]);assert.equal(result.notOk[0]?.sourceKnownName,'source-known assertion');assert.equal(result.notOk[0]?.code,'ERR_ASSERTION');assert.equal(result.notOk[0]?.operator,'strictEqual');assert.equal(result.notOk[0]?.actual,2);assert.equal(result.notOk[0]?.expected,3);assert.equal(result.notOk[0]?.location?.line,1);assert.equal(result.sourceFrames[0]?.sourceSha256,source.sha256);assert.ok(!JSON.stringify(result).includes('/private/'));
});
test('strings/config/unknown names and unsafe argv never escape; booleans/null remain useful',()=>{
  const secret='private-token-DSN-provider-body';const raw=block(JSON.stringify(secret),'{ password: '+secret+' }').replace('not ok 1 - source-known assertion','not ok 1 - '+secret);
  const result=diagnoseNode('/opt/node/bin/node',args,raw,'',[source],[]);assert.ok(result);assert.equal(result.notOk[0]?.nameKnown,false);assert.ok(!JSON.stringify(result).includes(secret));assert.equal(result.notOk[0]?.actual,undefined);assert.equal(result.notOk[0]?.expected,undefined);
  const safe=diagnoseNode('/opt/node/bin/node',args,block('false','null'),'',[source],[]);assert.equal(safe?.notOk[0]?.actual,false);assert.equal(safe?.notOk[0]?.expected,null);
  assert.equal(diagnoseNode('/opt/node/bin/node',['--token',secret,file],raw,'',[source],[]),undefined);
});
test('non-TAP module errors retain only allowlisted code and valid repository frames',()=>{
  const result=diagnoseNode('/opt/node/bin/node',args,'',`Error [ERR_MODULE_NOT_FOUND]: sensitive module detail\n at ${source.absolute}:2:3\n at /private/config.ts:1:1`,[source],[]);assert.deepEqual(result?.codes,['ERR_MODULE_NOT_FOUND']);assert.equal(result?.sourceFrames[0]?.file,file);assert.ok(!JSON.stringify(result).includes('sensitive module detail'));
  assert.deepEqual(frames(source.absolute+':999:1\n'+source.absolute+':2:999',[source]),[]);
});
test('YAML aliases and arbitrary objects are never converted/exported',()=>{
  const result=diagnoseNode('/opt/node/bin/node',args,block('&private { credential: secret }','*private'),'',[source],[]);assert.ok(result);assert.equal(result.notOk[0]?.actual,undefined);assert.equal(result.notOk[0]?.expected,undefined);assert.ok(!JSON.stringify(result).includes('secret'));
});
test('bounded first diagnostics preserve completed whole-suite evidence and flag truncation',()=>{
  const progress=[{file,tests:1,stdoutSha256:'a'.repeat(64)}];const result=diagnoseNode('/opt/node/bin/node',args,Array.from({length:20},()=>block('true','false')).join('\n'),'',[source],progress);assert.equal(result?.notOkCount,20);assert.equal(result?.notOk.length,16);assert.equal(result?.notOkTruncated,true);assert.deepEqual(result?.completedSuites,progress);
});

test('joined JSON failure retains only source-declared phase, allowlisted code and valid source frame',()=>{
  const joinedFile=testFiles[3],joinedText='let phase = "guard";\nphase = "native-build-provenance";\n';
  const joined:Source={file:joinedFile,absolute:'/owned/gateway/'+joinedFile,text:joinedText,sha256:createHash('sha256').update(joinedText).digest('hex')};
  const result=diagnoseNode('/opt/node/bin/node',[joinedFile],JSON.stringify({outcome:'fail',phase:'native-build-provenance',code:'ERR_ASSERTION',frame:'native-provider-joined.ts:2:1',privateBody:'secret'}),'',[joined],[]);
  assert.equal(result?.joined?.phase,'native-build-provenance');assert.equal(result?.joined?.sourceFrames[0]?.line,2);assert.ok(!JSON.stringify(result).includes('secret'));
});

test('line-only syntax/module headers retain validated line with explicit inferred column',()=>{
 const result=diagnoseNode('/opt/node/bin/node',args,'',source.absolute+':2\nSyntaxError: private detail',[source],[]);
 assert.equal(result?.sourceFrames[0]?.line,2);assert.equal(result?.sourceFrames[0]?.columnInferred,true);assert.ok(result?.errorClasses.includes('SyntaxError'));assert.ok(!JSON.stringify(result).includes('private detail'));
});

test('missing YAML terminator and row exhaustion are explicit truncation, never parsed as complete',()=>{
 const missing=block('2','3').replace('  ...\n','');const a=diagnoseNode('/opt/node/bin/node',args,missing,'',[source],[]);assert.equal(a?.notOk[0]?.diagnosticTruncated,true);assert.equal(a?.notOk[0]?.yamlParsed,false);assert.equal(a?.notOk[0]?.actual,undefined);
 const adjacent=diagnoseNode('/opt/node/bin/node',args,missing+block('4','5'),'',[source],[]);assert.equal(adjacent?.notOk[0]?.diagnosticTruncated,true);assert.equal(adjacent?.notOk[0]?.yamlParsed,false);assert.equal(adjacent?.notOk[1]?.actual,4);
 const many=block('2','3').replace('  code:',Array.from({length:2050},()=> '  # row').join('\n')+'\n  code:');const b=diagnoseNode('/opt/node/bin/node',args,many,'',[source],[]);assert.equal(b?.notOk[0]?.diagnosticTruncated,true);assert.equal(b?.notOk[0]?.yamlParsed,false);
 const bytes=block('2','3').replace('  code:','  # '+ 'x'.repeat(262145)+'\n  code:');const c=diagnoseNode('/opt/node/bin/node',args,bytes,'',[source],[]);assert.equal(c?.notOk[0]?.diagnosticTruncated,true);assert.equal(c?.notOk[0]?.yamlParsed,false);
});

test('only actual source-coded assembly/service phases and fixed usage codes escape',()=>{
 const phaseSource:Source={...source,text:source.text+'const phase="unprotected fixture"; const wait="native ready"; const env="AG_ASSEMBLY_KERNEL_DSN";'};
 const scalar=block('false','true').replace("  code: 'ERR_ASSERTION'","  error: 'assembly fixture: unprotected fixture'");
 const a=diagnoseNode('/opt/node/bin/node',args,scalar,'',[phaseSource],[]);assert.equal(a?.codedPhases[0]?.phase,'unprotected fixture');
 const timeout=diagnoseNode('/opt/node/bin/node',args,'','Error: assembly fixture: native ready timeout',[phaseSource],[]);assert.equal(timeout?.codedPhases[0]?.phase,'native ready timeout');
 const secret=diagnoseNode('/opt/node/bin/node',args,scalar.replace('unprotected fixture','SECRET_provider_token_credential'),'',[phaseSource],[]);assert.deepEqual(secret?.codedPhases,[]);assert.ok(!JSON.stringify(secret).includes('SECRET_provider'));
 const svc:Source={...source,file:testFiles[1],text:'const msg="service fixture: pinned bridge lost";'};const b=diagnoseNode('/opt/node/bin/node',['--test','--test-reporter=tap',testFiles[1]],'','Error: service fixture: pinned bridge lost',[svc],[]);assert.equal(b?.codedPhases[0]?.scope,'service');
 const usage:Source={...source,file:testFiles[2],text:'throw new Error("control capacity deadline");'};const c=diagnoseNode('/opt/node/bin/node',['--test','--test-reporter=tap',testFiles[2]],'','Error: control capacity deadline',[usage],[]);assert.equal(c?.codedPhases[0]?.scope,'service-usage');
});
