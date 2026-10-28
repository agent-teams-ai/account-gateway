// Finite Gateway TEST diagnostics: export identities/codes/scalars, never raw text.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap, isScalar } from 'yaml';
export const testFiles = ['services/account-gateway/test/native-runtime-assembly.test.ts','services/account-gateway/test/service-runtime.test.ts','services/account-gateway/test/service-usage-runtime.test.ts','services/account-gateway/test/native-provider-joined.ts'] as const;
export type TestFile = typeof testFiles[number];
export interface Frame { file:string;line:number;column:number;columnInferred?:boolean;sourceSha256:string; }
export interface Source { file:string;absolute:string;text:string;sha256:string; }
export interface CodedPhase { scope:'assembly'|'service'|'service-usage';phase:string;sourceKnown:true; }
export interface NotOk {codedPhase?:CodedPhase; sourceKnownName?:string;nameKnown:boolean;yamlParsed:boolean;yamlPresent:boolean;yamlErrorCount?:number;diagnosticTruncated?:boolean;location?:Frame;code?:string;errorClass?:string;operator?:string;actual?:number|boolean|null;expected?:number|boolean|null;actualType?:string;expectedType?:string;frames:Frame[]; }
export interface NodeDiagnostic { executable:string;argv:string[];testFile:TestFile;tapExpected:boolean;tap:boolean;notOkCount:number;notOk:NotOk[];notOkTruncated:boolean;codes:string[];codedPhases:CodedPhase[];errorClasses:string[];sourceFrames:Frame[];summary:Record<string,number>;completedSuites:{file:TestFile;tests:number;stdoutSha256:string;stderrSha256?:string;stdoutBytes?:number;stderrBytes?:number}[];fixtureMetadata?:FixtureMetadata[];joined?:{phase?:string;code?:string;sourceFrames:Frame[]}; }
export interface FixtureMetadata { path:string;present:boolean;uid?:number;gid?:number;mode?:string;symlink?:boolean;nlink?:number;size?:number;errorCode?:string; }
const codes = new Set(['ERR_ASSERTION','ERR_TEST_FAILURE','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE','ERR_MODULE_NOT_FOUND','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX','ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING','ERR_REQUIRE_ASYNC_MODULE','ERR_REQUIRE_ESM','ERR_INVALID_PACKAGE_CONFIG','ERR_UNKNOWN_BUILTIN_MODULE','ERR_UNSUPPORTED_ESM_URL_SCHEME','ERR_REQUIRE_CYCLE_MODULE','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_PACKAGE_IMPORT_NOT_DEFINED','ERR_UNSUPPORTED_DIR_IMPORT','MODULE_NOT_FOUND','ENOENT','EACCES','EPERM','ECONNREFUSED','ETIMEDOUT','EADDRINUSE','config_denied','startup_denied','runtime_denied','shutdown_pending']);
const operators=new Set(['==','!=','===','!==','>','>=','<','<=','ifError','strictEqual','notStrictEqual','deepStrictEqual','notDeepStrictEqual','equal','notEqual','deepEqual','notDeepEqual','ok','match','doesNotMatch','throws','doesNotThrow','rejects','doesNotReject','fail']);
const classes=new Set(['Error','AssertionError','TypeError','ReferenceError','SyntaxError','FixtureFailure','ServiceError','GatewayError']);
const sha=(bytes:string|Buffer):string=>createHash('sha256').update(bytes).digest('hex');
export function loadSources(root:string,hashes:Readonly<Record<string,string>>):Source[]{
  const result:Source[]=[];
  for(const [file,digest]of Object.entries(hashes)){
    if(!/\.(?:[cm]?ts|[cm]?js|tsx|go)$/.test(file)||file.startsWith('/')||file.split('/').includes('..'))continue;
    const absolute=resolve(root,file),bytes=readFileSync(absolute);if(sha(bytes)!==digest)throw new Error('diagnostic-source-integrity');
    result.push({file,absolute,text:bytes.toString('utf8'),sha256:digest});
  }
  return result;
}
export function frames(text:string,sources:readonly Source[]):Frame[]{
  const result:Frame[]=[];
  for(const m of text.matchAll(/((?:file:\/\/\/|\/)[^\n\r()]*?):([1-9][0-9]*)(?::([1-9][0-9]*))?(?![0-9:])/g)){
    let absolute:string;try{absolute=m[1]!.startsWith('file:')?fileURLToPath(m[1]!):resolve(m[1]!);}catch{continue;}
    const source=sources.find(s=>s.absolute===absolute);if(!source)continue;
    const line=Number(m[2]),column=m[3]===undefined?1:Number(m[3]),lines=source.text.split('\n');
    if(!Number.isSafeInteger(line)||!Number.isSafeInteger(column)||line>lines.length||column>lines[line-1]!.length+1)continue;
    const frame={file:source.file,line,column,...(m[3]===undefined?{columnInferred:true}:{}),sourceSha256:source.sha256};
    if(!result.some(f=>f.file===frame.file&&f.line===line&&f.column===column))result.push(frame);
    if(result.length===12)break;
  }
  return result;
}
function names(source:Source|undefined):Set<string>{
  const result=new Set<string>();if(!source)return result;
  for(const m of source.text.matchAll(/\btest\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)){
    const literal=m[1]!;try{if(literal[0]==='"')result.add(JSON.parse(literal));else if(!/\\(?!['"\\])/.test(literal))result.add(literal.slice(1,-1).replace(/\\(['"\\])/g,'$1'));}catch{}
  }
  return result;
}
function sourceLiterals(sources:readonly Source[]):Set<string>{const result=new Set<string>();for(const source of sources)for(const m of source.text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)){const literal=m[0];try{if(literal[0]==='"')result.add(JSON.parse(literal));else if(!/\\(?!['"\\])/.test(literal))result.add(literal.slice(1,-1).replace(/\\(['"\\])/g,'$1'));}catch{}}return result;}
function codedPhase(error:unknown,file:TestFile,literals:ReadonlySet<string>):CodedPhase|undefined{
  if(typeof error!=='string')return undefined;const message=error.trim();
  const prefix=file===testFiles[0]?'assembly fixture: ':file===testFiles[1]?'service fixture: ':undefined;
  if(prefix&&message.startsWith(prefix)){const phase=message.slice(prefix.length);if(!/^[A-Za-z][A-Za-z0-9 _./:-]{0,119}$/.test(phase))return undefined;const base=phase.endsWith(' timeout')?phase.slice(0,-8):phase;const missing=base.startsWith('NOT_RUN missing ')?base.slice(16):undefined;if(literals.has(phase)||literals.has(base)||literals.has(message)||missing&&literals.has(missing))return{scope:file===testFiles[0]?'assembly':'service',phase,sourceKnown:true};}
  if(file===testFiles[2]&&['NOT_RUN: explicit disposable DB required','NOT_RUN: explicit isolated root/Linux fixture required','control capacity deadline','fixture account not created','no controlled stream'].includes(message)&&literals.has(message))return{scope:'service-usage',phase:message,sourceKnown:true};
  return undefined;
}
function scalarType(value:unknown):string{return value===null?'null':Array.isArray(value)?'array':typeof value;}
function safeValue(value:unknown):value is number|boolean|null{return value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value));}
export function diagnoseNode(executable:string,args:readonly string[],stdout:string,stderr:string,sources:readonly Source[],completed:NodeDiagnostic['completedSuites']):NodeDiagnostic|undefined{
  const file=args.at(-1);if(!(testFiles as readonly string[]).includes(file??''))return undefined;
  const testFile=file as TestFile;const tapExpected=testFile!==testFiles[3],tap=/^TAP version 13$/m.test(stdout)||/^1\.\.[0-9]+$/m.test(stdout);
  if(tapExpected?args.length!==3||args[0]!=='--test'||args[1]!=='--test-reporter=tap':args.length!==1)return undefined;
  const literals=sourceLiterals(sources.filter(s=>s.file===testFile||s.file.startsWith('services/account-gateway/test/fixtures/')&&s.file.endsWith('.go'))),codedPhases:CodedPhase[]=[];const allowedNames=names(sources.find(s=>s.file===testFile)),notOk:NotOk[]=[];const lines=stdout.split('\n');let notOkCount=0;
  for(let i=0;i<lines.length;i++){
    const m=/^(\s*)not ok\s+[0-9]+(?:\s+-\s+(.*))?$/.exec(lines[i]!);if(!m)continue;notOkCount++;if(notOk.length===16)continue;
    const name=(m[2]??'').replace(/\s+#\s*(?:SKIP|TODO)\b.*$/i,'');const item:NotOk={nameKnown:allowedNames.has(name),yamlParsed:false,yamlPresent:false,frames:[]};if(item.nameKnown)item.sourceKnownName=name;
    const indent=m[1]!.length+2,prefix=' '.repeat(indent);let block='';
    if(lines[i+1]===prefix+'---'){item.yamlPresent=true;let closed=false,rows=0,bytes=0;for(let j=i+2;j<lines.length;j++){if(lines[j]===prefix+'...'){closed=true;break;}if(lines[j]!.trim()!==''&&!lines[j]!.startsWith(prefix)){item.diagnosticTruncated=true;break;}const row=lines[j]!.slice(indent)+'\n';rows++;bytes+=Buffer.byteLength(row);if(rows>2048||bytes>262144){item.diagnosticTruncated=true;break;}block+=row;}if(!closed){item.diagnosticTruncated=true;block='';}}
    if(block)try{
      const doc=parseDocument(block,{schema:'core',prettyErrors:false,logLevel:'silent',uniqueKeys:true});
      item.yamlErrorCount=doc.errors.length;if(isMap(doc.contents)){item.yamlParsed=doc.errors.length===0;
        const map=doc.contents;const get=(key:string):unknown=>{const node=map.get(key,true);return isScalar(node)?node.value:undefined;};
        const code=get('code'),error=get('error'),errorClass=get('name'),operator=get('operator');
        item.codedPhase=codedPhase(error,testFile,literals);if(item.codedPhase&&!codedPhases.some(p=>p.scope===item.codedPhase!.scope&&p.phase===item.codedPhase!.phase))codedPhases.push(item.codedPhase);
        if(typeof code==='string'&&codes.has(code))item.code=code;else if(typeof error==='string'&&codes.has(error))item.code=error;
        if(typeof errorClass==='string'&&classes.has(errorClass))item.errorClass=errorClass;
        if(typeof operator==='string'&&operators.has(operator))item.operator=operator;
        for(const key of ['actual','expected']as const){const value=get(key);item[key+'Type'as 'actualType'|'expectedType']=value===undefined&&map.has(key)?'non-scalar':scalarType(value);if(safeValue(value))item[key]=value;}
        const location=get('location');if(typeof location==='string')item.location=frames(location,sources)[0];const stack=get('stack');if(typeof stack==='string')item.frames=frames(stack,sources);
      }
    }catch{}
    notOk.push(item);
  }
  const text=stdout+'\n'+stderr;for(const line of text.split('\n')){const m=/^\s*(?:#\s*)?(?:Error|FixtureFailure): (.{1,160})$/.exec(line);const phase=m?codedPhase(m[1],testFile,literals):undefined;if(phase&&!codedPhases.some(p=>p.scope===phase.scope&&p.phase===phase.phase))codedPhases.push(phase);}
  const foundCodes=[...codes].filter(c=>new RegExp('(?:\\bcode:\\s*[\'\"]?|\\bError\\s*\\[|\\berror:\\s*[\'\"]?)'+c+'(?:\\b|[\'\"\\]])').test(text));
  const summary:Record<string,number>={};for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo']){const m=new RegExp('^# '+key+' ([0-9]+)$','m').exec(stdout);if(m&&Number.isSafeInteger(Number(m[1])))summary[key]=Number(m[1]);}
  let joined:NodeDiagnostic['joined'];
  if(!tapExpected){const source=sources.find(s=>s.file===testFile),phases=new Set([...source?.text.matchAll(/\bphase\s*=\s*["']([a-z][a-z0-9-]{0,80})["']/g)??[]].map(m=>m[1]));for(const line of lines)try{const value:unknown=JSON.parse(line);if(value&&typeof value==='object'&&!Array.isArray(value)){const r=value as Record<string,unknown>;if(r.outcome==='fail'){joined={sourceFrames:[]};if(typeof r.phase==='string'&&phases.has(r.phase))joined.phase=r.phase;if(typeof r.code==='string'&&codes.has(r.code))joined.code=r.code;if(typeof r.frame==='string'&&source){const m=/^native-provider-joined\.ts:([1-9][0-9]*):([1-9][0-9]*)$/.exec(r.frame);if(m)joined.sourceFrames=frames(source.absolute+':'+m[1]+':'+m[2],sources);}}}}catch{}}
  return{executable,argv:[executable,...args],testFile,tapExpected,tap,notOkCount,notOk,notOkTruncated:notOkCount>notOk.length,codes:foundCodes,codedPhases,errorClasses:[...classes].filter(c=>new RegExp('(?:^|\\n)(?:#\\s*)?'+c+'(?:\\s*\\[[A-Z_]+\\])?:').test(text)),sourceFrames:frames(text,sources),summary,completedSuites:completed,...(joined?{joined}:{})};
}
const custodyPaths=['/root','/opt','/etc/ssl/certs/ca-certificates.crt',...['assembly','service-entry','service-usage'].flatMap(kind=>{const root='/opt/account-gateway-'+kind,tls=kind==='service-usage'?root:root+'/tls';return[root,...(tls!==root?[tls]:[]),root+'/'+(kind==='assembly'?'gateway-assembly-fixture':'account-gateway'),tls+'/ca.pem',tls+'/server.pem',tls+'/server-key.pem',...(kind==='service-entry'?[root+'/fixture.json']:[])];})];
export function fixtureMetadata():FixtureMetadata[]{return custodyPaths.map(path=>{try{const s=lstatSync(path);return{path,present:true,uid:s.uid,gid:s.gid,mode:s.mode.toString(8),symlink:s.isSymbolicLink(),nlink:s.nlink,size:s.size};}catch(error){const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';return{path,present:false,errorCode:['ENOENT','EACCES','EPERM'].includes(code)?code:'metadata-unavailable'};}});}
