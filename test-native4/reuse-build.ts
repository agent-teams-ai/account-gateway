// Finite TEST reuse of two immutable, source-bound artifacts; never builds Go.
import { createProcessExecutor } from 'node-or-bun';
import { createNodeProcessAdapter } from 'node-or-bun/node';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, existsSync, mkdirSync, chmodSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyGoPins } from './toolchain.ts';
import type { BuildReceipt } from './build-contract.ts';
interface Pin { id:number;name:string;size:number;sha256:string;buildReceiptSHA256:string; }
interface Inputs { kind:string;repositoryId:number;producerRun:number;producerOverlay:string;gateway:string;native:string;goModSHA256:string;goSumSHA256:string;assemblySHA256:string;lanes:Record<string,Pin>; }
const inputs=JSON.parse(readFileSync(new URL('./reuse-inputs.json',import.meta.url),'utf8')) as Inputs;
const binaries=['account-gateway','gateway-assembly-fixture','native-provider-joined','native-migrate'] as const;
function check(v:unknown,code:string):asserts v {if(!v)throw new Error(code);}
export function selectPin(node:string):Pin {check(Object.hasOwn(inputs.lanes,node),'reuse-node');return inputs.lanes[node]!;}
export function validateProvider(meta:unknown,node:string):void {
  const pin=selectPin(node);check(meta&&typeof meta==='object'&&!Array.isArray(meta),'reuse-provider');
  const m=meta as Record<string,unknown>,w=m.workflow_run as Record<string,unknown>|undefined;
  check(m.id===pin.id&&m.name===pin.name&&m.size_in_bytes===pin.size&&m.digest==='sha256:'+pin.sha256&&m.expired===false&&w?.id===inputs.producerRun&&w?.head_sha===inputs.producerOverlay&&w?.repository_id===inputs.repositoryId&&w?.head_repository_id===inputs.repositoryId,'reuse-provider-binding');
}
async function hash(file:string):Promise<string>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function reuse(node:string,metaFile:string,zip:string,gateway:string,go:string,destination:string):Promise<void>{
  const pin=selectPin(node);validateProvider(JSON.parse(readFileSync(metaFile,'utf8')),node);
  check(!existsSync(destination),'reuse-fresh-directory');check(statSync(zip).size===pin.size&&await hash(zip)===pin.sha256,'reuse-zip-sri');
  const executor=createProcessExecutor(createNodeProcessAdapter());const cache=destination+'-readonly-cache';check(!existsSync(cache),'reuse-cache-fresh');mkdirSync(cache,{mode:0o500});
  const environment:Record<string,string>={PATH:process.env.PATH??'/usr/bin:/bin',GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',GOPROXY:'off',GOSUMDB:'off',GOVCS:'*:off',GOCACHE:cache,GOMODCACHE:cache,GOPATH:cache};if(process.env.TMPDIR)environment.TMPDIR=process.env.TMPDIR;
  const run=async(command:string,args:string[],cwd=gateway):Promise<string>=>{const result=await executor.run({command,args,cwd,environment,timeoutMs:60000,strictUtf8:true});check(result.exitCode===0&&result.signal===null,'reuse-command');return result.stdout.trim();};
  check(await run('git',['rev-parse','HEAD'])===inputs.gateway&&await run('git',['diff','--name-only','HEAD'])==='','reuse-gateway-source');
  const entries=(await run('/usr/bin/unzip',['-Z1',zip])).split('\n');const expected=['build.json','gateway-source.tar',...binaries];check(entries.length===expected.length&&new Set(entries).size===expected.length&&entries.every(e=>expected.includes(e)),'reuse-zip-entries');
  mkdirSync(destination,{mode:0o700});await run('/usr/bin/unzip',['-q',zip,'-d',destination]);
  for(const name of expected){const s=lstatSync(join(destination,name));check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'reuse-file-kind');}
  check(await hash(join(destination,'build.json'))===pin.buildReceiptSHA256,'reuse-receipt-digest');const b=JSON.parse(readFileSync(join(destination,'build.json'),'utf8')) as BuildReceipt;
  check(b.kind==='gateway-native4-build/v1'&&b.gatewayCommit===inputs.gateway&&b.nativeCommit===inputs.native&&b.nodeVersion==='v'+node&&process.version==='v'+node&&b.goMod===inputs.goModSHA256&&b.goSum===inputs.goSumSHA256,'reuse-build-tuple');
  check(await hash(process.execPath)===b.nodeExecutableSHA256&&await hash(go)===b.goExecutableSHA256,'reuse-toolchain-bytes');const version=await run(go,['version']);check(version===b.goVersion,'reuse-compiler');
  const goMod=readFileSync(new URL('./accepted-native-go.mod',import.meta.url),'utf8');check(createHash('sha256').update(goMod).digest('hex')===inputs.goModSHA256,'reuse-native-contract');qualifyGoPins(goMod,readFileSync(join(gateway,'services/account-gateway/test/fixtures/native-assembly/main.go'),'utf8'),version);
  check(b.sourceHashes['services/account-gateway/test/fixtures/native-assembly/main.go']===inputs.assemblySHA256,'reuse-fixture-pin');
  for(const [file,digest]of Object.entries(b.gatewayTrackedHashes)){check(!file.startsWith('/')&&!file.split('/').includes('..')&&await hash(join(gateway,file))===digest,'reuse-tracked-source');}
  for(const [file,digest]of Object.entries(b.sourceHashes))check(await hash(join(gateway,file))===digest,'reuse-fixture-source');
  check(await hash(join(destination,'gateway-source.tar'))===b.gatewaySourceArchiveSHA256&&await hash(new URL('./native-migrate.go',import.meta.url).pathname)===b.migrationHelperSHA256,'reuse-source-archive');check(Object.keys(b.binaries).length===binaries.length&&binaries.every(n=>Object.hasOwn(b.binaries,n)),'reuse-binary-inventory');
  for(const name of binaries){check(await hash(join(destination,name))===b.binaries[name]!.sha256,'reuse-binary-digest');const info=await run(go,['version','-m',join(destination,name)]);check(info.includes('vcs.revision='+inputs.native)&&info.includes('vcs.modified=false')&&info.includes('go1.27.3'),'reuse-binary-vcs');}
  for(const name of expected)chmodSync(join(destination,name),binaries.includes(name as typeof binaries[number])?0o555:0o444);chmodSync(destination,0o555);
  writeFileSync(destination+'-reuse.json',JSON.stringify({kind:'gateway-native4-build-reuse/v1',producerRun:inputs.producerRun,producerOverlay:inputs.producerOverlay,artifactId:pin.id,zipSHA256:pin.sha256,integrity:'sha256-'+Buffer.from(pin.sha256,'hex').toString('base64'),buildReceiptSHA256:pin.buildReceiptSHA256,gateway:inputs.gateway,native:inputs.native,node,goBuiltAgain:false,sourceCacheReadOnly:true,metadataCacheReadOnly:true})+'\n',{flag:'wx',mode:0o600});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const args=process.argv.slice(2);if(args.length===2&&args[0]==='--artifact-id')process.stdout.write(String(selectPin(args[1]!).id)+'\n');else{check(args.length===6,'reuse-arguments');await reuse(args[0]!,...args.slice(1) as [string,string,string,string,string]);}}
  catch(error){process.stderr.write(JSON.stringify({outcome:'fail',code:error instanceof Error&&/^[a-z-]+$/.test(error.message)?error.message:'reuse-failed'})+'\n');process.exitCode=1;}
}
