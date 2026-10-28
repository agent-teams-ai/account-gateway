// Finite Gateway Host TEST policy. Never import this operator in product code.
import { createProcessExecutor, isProcessRuntimeError } from 'node-or-bun';
import { createNodeProcessAdapter } from 'node-or-bun/node';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { qualifyTap } from './tap.ts';
import { qualifyGoPins } from './toolchain.ts';
const gatewayCommit = '5a1ad4a00a8941f1263d927ab23297bafa640661';
const expectedAssemblyFixtureSHA256 = '6179f4af873275aabdefd3a270cc338b47abff14379134ab4f65d4c02de59047';
const nativeCommit = '32cd6f50e76c29b578ee013900484c56013814bc';
const pgImage = 'postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317';
const normHash = '66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0';
const exec = createProcessExecutor(createNodeProcessAdapter());
function check(v: unknown, code: string): asserts v { if (!v) throw new Error(code); }
const hash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');
const key = (): string => randomBytes(32).toString('base64');
const opts = new Map<string,string>();
for (let i=2;i<process.argv.length;i+=2) { const k=process.argv[i],v=process.argv[i+1]; check(k && ['--phase','--gateway','--native','--output','--go','--build'].includes(k) && v && !opts.has(k),'arguments');opts.set(k,v); }
function option(k: string): string { const v=opts.get(k);check(v,'missing-'+k);return v; }
const phase=option('--phase'),gateway=resolve(option('--gateway')),native=resolve(option('--native')),output=resolve(option('--output'));
const env: Record<string,string> = {};
for (const k of ['PATH','HOME','TMPDIR','GOPATH','GOCACHE','GOMODCACHE','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS']) { const v=process.env[k];if(v)env[k]=v; }
Object.assign(env,{GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',CGO_ENABLED:'0',NODE_DISABLE_COMPILE_CACHE:'1'});
let step='guard';let lastFailure:unknown;
async function run(command: string,args: readonly string[],cwd=gateway,extra: Record<string,string>={},timeoutMs=600_000): Promise<string> {
  step=command.split('/').at(-1) ?? 'command';
  const r=await exec.run({command,args,cwd,environment:{...env,...extra},timeoutMs,strictUtf8:true});
  if(r.exitCode!==0||r.signal!==null){const safePhase=/\"phase\":\s*\"([a-z][a-z0-9-]{0,80})\"/.exec(r.stdout)?.[1];const fixturePhase=/service fixture: ([a-z][a-z ]{0,80})/.exec(r.stdout)?.[1];lastFailure={exitCode:r.exitCode,signal:r.signal,stdoutSha256:createHash('sha256').update(r.stdout).digest('hex'),stderrSha256:createHash('sha256').update(r.stderr).digest('hex'),safePhase,fixturePhase};throw new Error('command-failed-'+step);}
  return r.stdout.trim(); // Never export raw stderr, provider bodies or configurations.
}
function json(path:string,value:unknown):void { writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); }
function fresh(path:string,mode=0o700):void {check(!existsSync(path),'path-exists');mkdirSync(path,{recursive:true,mode});}
function protectedPath(path:string):void {
  for(let p=path;;p=dirname(p)){const s=lstatSync(p);check(s.uid===0&&!s.isSymbolicLink()&&(s.mode&0o022)===0,'unprotected-path');if(p==='/')break;}
}
async function origin():Promise<string>{const s=createServer();await new Promise<void>((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});const a=s.address();check(a&&typeof a==='object','port');await new Promise<void>((ok,no)=>s.close(e=>e?no(e):ok()));return 'http://127.0.0.1:'+a.port;}
const files = ['services/account-gateway/test/fixtures/native-assembly/main.go','services/account-gateway/test/fixtures/native-provider-joined/main.go','services/account-gateway/test/native-runtime-assembly.test.ts','services/account-gateway/test/service-runtime.test.ts','services/account-gateway/test/service-usage-runtime.test.ts','services/account-gateway/test/native-provider-joined.ts','services/account-gateway/src/service.ts'];
function sourceHashes():Record<string,string>{return Object.fromEntries(files.map(f=>[f,hash(join(gateway,f))]));}
async function cleanSource():Promise<void>{
  check(await run('git',['rev-parse','HEAD'],gateway)===gatewayCommit,'gateway-pin');
  check(await run('git',['diff','--name-only','HEAD'],gateway)==='','gateway-tracked-dirty');
  check(await run('git',['rev-parse','HEAD'],native)===nativeCommit,'native-pin');
  check(await run('git',['status','--porcelain','--untracked-files=all'],native)==='','native-dirty');
}
interface BuildReceipt {kind:'gateway-native4-build/v1';gatewayCommit:string;nativeCommit:string;goVersion:string;nodeVersion:string;goMod:string;goSum:string;gatewaySourceArchiveSHA256:string;goExecutableSHA256:string;nodeExecutableSHA256:string;sourceHashes:Record<string,string>;gatewayTrackedHashes:Record<string,string>;migrationHelperSHA256:string;binaries:Record<string,{path:string;sha256:string;buildInfo:string}>;}
async function build():Promise<void>{
  await cleanSource();const go=option('--go');check(isAbsolute(go),'absolute-go');
  const goVersion=await run(go,['version'],native);check(goVersion==='go version go1.27.3 linux/amd64','go-pin');
  const tracked=(await run('git',['ls-files','-z'],gateway)).split('\0').filter(Boolean);const gatewayTrackedHashes=Object.fromEntries(tracked.map(f=>[f,hash(join(gateway,f))]));
  const goMod=hash(join(native,'backend/go.mod')),goSum=hash(join(native,'backend/go.sum')),sources=sourceHashes();
  check(goMod==='adf5c15bf5fb54d5957279d0fcaf7281f49651a754c9deb89fed0f44a8799135'&&goSum==='b17668c6300c04027bd397650e60e28e514dc4abb9ab113e3cea634fdd708109','accepted-native-module-bytes');
  check(sources[files[0]!]===expectedAssemblyFixtureSHA256,'accepted-assembly-fixture-bytes');
  qualifyGoPins(readFileSync(join(native,'backend/go.mod'),'utf8'),readFileSync(join(gateway,files[0]!),'utf8'),goVersion);fresh(output);
  await run('git',['archive','--format=tar','--output='+join(output,'gateway-source.tar'),gatewayCommit],gateway);const gatewaySourceArchiveSHA256=hash(join(output,'gateway-source.tar'));
  const binaries:BuildReceipt['binaries']={};
  const targets:[string,string,string|undefined][]=[['account-gateway','./cmd/account-gateway',undefined],['gateway-assembly-fixture','./tmp/native-assembly',files[0]],['native-provider-joined','./tmp/native-provider-joined',files[1]],['native-migrate','./tmp/native-migrate',undefined]];
  for(const [name,target,source]of targets){
    if(target.startsWith('./tmp/')){
      const relative='backend/'+target.slice(2)+'/main.go';check(await run('git',['check-ignore',relative],native)===relative,'ignored-fixture');
      const dir=join(native,dirname(relative));fresh(dir);
      if(source)copyFileSync(join(gateway,source),join(dir,'main.go'));
      else copyFileSync(join(dirname(new URL(import.meta.url).pathname),'native-migrate.go'),join(dir,'main.go'));
    }
    const path=join(output,name);await run(go,['build','-p=2','-mod=readonly','-buildvcs=true','-o',path,target],join(native,'backend'));
    const buildInfo=await run(go,['version','-m',path],native);check(buildInfo.includes('vcs.revision='+nativeCommit)&&buildInfo.includes('vcs.modified=false'),'binary-provenance');
    binaries[name]={path,sha256:hash(path),buildInfo};
  }
  await cleanSource();check(hash(join(native,'backend/go.mod'))===goMod&&hash(join(native,'backend/go.sum'))===goSum,'module-changed');check(JSON.stringify(sources)===JSON.stringify(sourceHashes()),'gateway-changed');
  json(join(output,'build.json'),{kind:'gateway-native4-build/v1',gatewayCommit,nativeCommit,goVersion,nodeVersion:process.version,goMod,goSum,gatewaySourceArchiveSHA256,goExecutableSHA256:hash(go),nodeExecutableSHA256:hash(process.execPath),sourceHashes:sources,gatewayTrackedHashes,migrationHelperSHA256:hash(join(dirname(new URL(import.meta.url).pathname),'native-migrate.go')),binaries} satisfies BuildReceipt);
}
async function runtime():Promise<void>{
  check(process.platform==='linux'&&process.geteuid?.()===0,'root-linux');check(['v26.11.1','v24.21.0'].includes(process.version),'node-pin');
  check(process.env.GATEWAY_NATIVE4_ALLOW==='fresh_isolated_root_linux_pg17_10','runtime-opt-in');
  const pythonPidfd=await run('/usr/bin/python3',['-I','-c',"import os,signal,select,sys; assert callable(os.pidfd_open) and callable(signal.pidfd_send_signal); fd=os.pidfd_open(os.getpid(),0); signal.pidfd_send_signal(fd,0,None,0); assert select.select([fd],[],[],0)[0]==[]; os.close(fd); print('python3-pidfd-ready '+sys.version.split()[0])"]);check(/^python3-pidfd-ready [0-9]+\.[0-9]+\.[0-9]+$/.test(pythonPidfd),'python-pidfd-unavailable');
  check(!process.env.NODE_TLS_REJECT_UNAUTHORIZED,'tls-bypass');check(readFileSync('/proc/net/dev','utf8').split('\n').filter(l=>l.includes(':')).every(l=>l.trim().startsWith('lo:')),'runtime-external-interface');fresh(output);protectedPath('/root');
  const build=resolve(option('--build'));const b=JSON.parse(readFileSync(join(build,'build.json'),'utf8')) as BuildReceipt;
  check(b.kind==='gateway-native4-build/v1'&&b.gatewayCommit===gatewayCommit&&b.nativeCommit===nativeCommit,'build-tuple');check(hash(join(build,'gateway-source.tar'))===b.gatewaySourceArchiveSHA256&&hash(option('--go'))===b.goExecutableSHA256&&hash(process.execPath)===b.nodeExecutableSHA256,'runtime-toolchain-or-archive');check(JSON.stringify(b.sourceHashes)===JSON.stringify(sourceHashes()),'runtime-source-hashes');
  for(const [f,digest]of Object.entries(b.gatewayTrackedHashes)){check(!f.startsWith('/')&&!f.split('/').includes('..')&&hash(join(gateway,f))===digest,'runtime-tracked-source');}
  for(const [name,v]of Object.entries(b.binaries))check(hash(join(build,name))===v.sha256,'runtime-binary-hash');
  const pg='/usr/lib/postgresql/17/bin';env.PATH=pg+':'+(env.PATH??'/usr/bin:/bin');check((await run(join(pg,'psql'),['--version'])).includes('17.10'),'psql-version');check((await run(join(pg,'pg_dump'),['--version'])).includes('17.10'),'pgdump-version');
  // Fresh image filesystem, no reused cluster, no network interface except loopback.
  const pgdata='/var/lib/postgresql/native4';fresh(pgdata);await run('chown',['postgres:postgres',pgdata]);
  await run('gosu',['postgres',join(pg,'initdb'),'-D',pgdata,'-A','trust','--no-locale']);
  await run('gosu',['postgres',join(pg,'pg_ctl'),'-D',pgdata,'-l',pgdata+'/server.log','-o',"-h 127.0.0.1 -p 5432 -k /tmp",'-w','start']);
  let stopped=false;let runtimeReceipt:unknown;
  const sql=async(db:string,text:string):Promise<string>=>run(join(pg,'psql'),['-h','127.0.0.1','-p','5432','-U','postgres','-d',db,'-X','-A','-t','-v','ON_ERROR_STOP=1','-c',text]);
  const create=async(name:string):Promise<void>=>{check(/^[a-z0-9_]+$/.test(name),'db-name');await sql('postgres','CREATE DATABASE '+name);};
  const dsn=(db:string):string=>'postgres://postgres@127.0.0.1:5432/'+db+'?sslmode=disable';
  const id=randomUUID().replaceAll('-',''),suffix=id.slice(0,16),cert='/usr/local/share/ca-certificates/native4.crt',tls='/root/native4-tls';fresh(tls);
  try {
    check((await sql('postgres',"SHOW server_version")).startsWith('17.10'),'server-version');
    await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',tls+'/server-key.pem','-out',cert]);chmodSync(tls+'/server-key.pem',0o600);await run('update-ca-certificates',[]);
    for(const dir of ['/opt/account-gateway-assembly','/opt/account-gateway-service-entry','/opt/account-gateway-service-usage']){
      fresh(dir,0o755);const t=dir.endsWith('usage')?dir:dir+'/tls';if(t!==dir)fresh(t,0o755);
      copyFileSync(cert,t+'/ca.pem');copyFileSync(cert,t+'/server.pem');copyFileSync(tls+'/server-key.pem',t+'/server-key.pem');chmodSync(t+'/server-key.pem',0o600);
      const name=dir.endsWith('assembly')?'gateway-assembly-fixture':'account-gateway';copyFileSync(join(build,name),dir+'/'+name);chmodSync(dir+'/'+name,0o755);protectedPath(dir+'/'+name);
    }
    const ak='ag_kernel_test_assembly_'+suffix,an='native_bootstrap_assembly_'+suffix;await create(ak);await create(an);
    const tapEvidence:Record<string,{tests:number;sha256:string}>={};
    const reports:Record<string,{passed:true}>={};
    const suite=async(file:string,extra:Record<string,string>):Promise<void>=>{const tap=await run(process.execPath,['--test','--test-reporter=tap',file],gateway,extra,180_000);const { tests }=qualifyTap(tap);tapEvidence[file]={tests,sha256:createHash('sha256').update(tap).digest('hex')};};
    await suite(files[2]!,{AG_ASSEMBLY_ALLOW:'disposable_root_pg17_10',AG_ASSEMBLY_KERNEL_DSN:dsn(ak),AG_ASSEMBLY_NATIVE_DSN:dsn(an)});reports.assembly={passed:true};
    const sk='ag_service_entry_kernel_'+id,sn='ag_service_entry_native_'+id;await create(sk);await create(sn);
    // Original byte-for-byte numbered Gateway SQL and native repository migrator.
    for(const file of readdirSync(join(gateway,'services/account-gateway/migrations')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await run(join(pg,'psql'),['-h','127.0.0.1','-U','postgres','-d',sk,'-X','-v','ON_ERROR_STOP=1','-f',join(gateway,'services/account-gateway/migrations',file)]);
    await run(join(build,'native-migrate'),[],gateway,{GATEWAY_NATIVE4_MIGRATE_DSN:dsn(sn)});
    const root='/root/account_gateway_service_entry_'+id;fresh(root);fresh(root+'/authority');
    const consumer={consumerId:'native4-'+suffix,managementCredential:token(),executionCredential:token(),cleanupCredential:token(),callbackCredential:token()};
    const limits={requests:2,concurrency:1,requestBytes:4096,outputBytes:65536,tokens:32};
    const profile={profile:'openai-responses-apikey-v1',model:'mimo-test',qualificationRef:'controlled-service-entry-v1',baseURL:(await origin()).replace('http:','https:')+'/v1',limits,providerTokenUpperBound:100};
    const ownerRef='native4-owner',facadeOrigin=await origin(),callbackOrigin=await origin(),nativeOrigin=await origin();
    const service={kernelDSN:dsn(sk),facadeOrigin,callbackOrigin,durableFacts:{maxServiceFacts:128,maxConsumerFacts:96,maxAccountFacts:64,workerSlots:2,issuerSlots:3},native:{executable:'/opt/account-gateway-service-entry/account-gateway',sha256:b.binaries['account-gateway']!.sha256,bootstrapFile:root+'/bootstrap.json',authorityDir:root+'/authority',origin:nativeOrigin,originRef:'native4-service',uid:65534,gid:65534},consumer,profile,bearers:[{role:'management',token:token(),consumerId:consumer.consumerId,ownerRefs:[ownerRef],preparation:{accountRefs:[],subjectRef:'service-fixture-binding',policyRevision:1,bindingRevision:1,profileId:profile.profile,limits,maxRunMs:120000}},{role:'run-control',token:token(),consumerId:consumer.consumerId,ownerRefs:[ownerRef],profileIds:[profile.profile],limits,maxRunMs:120000}],keys:{intentAEAD:key(),intentHMAC:key(),facadeHMAC:key()}};
    json(root+'/service.json',service);
    json(root+'/bootstrap.json',{listenAddress:new URL(nativeOrigin).host,postgresDSN:dsn(sn),authority:{origin:callbackOrigin,credential:consumer.callbackCredential},custody:{activeKeyId:'fixture',keys:[{id:'fixture',key:key()}]},peers:[{consumerId:consumer.consumerId,role:'management',credential:consumer.managementCredential},{consumerId:consumer.consumerId,role:'execution',credential:consumer.executionCredential},{consumerId:consumer.consumerId,role:'cleanup',credential:consumer.cleanupCredential}],profile:{model:profile.model,baseURL:profile.baseURL,qualificationRef:profile.qualificationRef,requestBytes:limits.requestBytes,outputBytes:limits.outputBytes,tokens:limits.tokens,providerTokenUpperBound:100},maxEntries:8});
    json('/opt/account-gateway-service-entry/fixture.json',{serviceConfig:root+'/service.json',nativeDSN:dsn(sn),gatewaySourceRef:gatewayCommit,nativeSourceRef:nativeCommit,normHash,retirementReadbackSources:{gatewayBaseRef:'bc36b9ad16a90d1e45f7b6e30e16e0070b7905e5',nativeBaseRef:'b7d746411cb590af5156fe16436d3182c209b379',serviceSha256:b.sourceHashes['services/account-gateway/src/service.ts'],testSha256:b.sourceHashes[files[3]!],nativeExecutableSha256:b.binaries['account-gateway']!.sha256}});
    await suite(files[3]!,{AG_SERVICE_ENTRY_ALLOW:'new_disposable_root_pg17_10'});reports.service={passed:true};
    await create('ag_usage_service_20261022');await create('native_bootstrap_usage_20261022');
    await suite(files[4]!,{AG_SERVICE_USAGE_ALLOW:'new_disposable_root_pg17_10',AG_SERVICE_USAGE_KERNEL_DSN:'postgres://postgres@127.0.0.1:5432/ag_usage_service_20261022',AG_SERVICE_USAGE_NATIVE_DSN:'postgres://postgres@127.0.0.1:5432/native_bootstrap_usage_20261022',AG_SERVICE_USAGE_NATIVE_SHA256:b.binaries['account-gateway']!.sha256});reports.usage={passed:true};
    // Same fresh cluster, distinct listener port; no PG schemas/databases reused.
    await run('gosu',['postgres',join(pg,'pg_ctl'),'-D',pgdata,'-m','fast','-w','stop']);stopped=true;
    const port=new URL(await origin()).port;await run('gosu',['postgres',join(pg,'pg_ctl'),'-D',pgdata,'-l',pgdata+'/server.log','-o','-h 127.0.0.1 -p '+port+' -k /tmp','-w','start']);stopped=false;
    const jn='native_provider_joined_'+suffix,jk='ag_kernel_test_provider_joined_'+suffix;
    for(const db of [jn,jk])await run(join(pg,'createdb'),['-h','127.0.0.1','-p',port,'-U','postgres',db]);
    const joined='/tmp/native-provider-joined';fresh(joined,0o755);copyFileSync(join(build,'native-provider-joined'),joined+'/fixture');chmodSync(joined+'/fixture',0o755);
    const joinedOutput=await run(process.execPath,[files[5]!],gateway,{AG_NATIVE_PROVIDER_JOINED_ALLOW:'disposable_pg17_10',AG_NATIVE_PROVIDER_JOINED_NATIVE_DSN:'postgres://postgres@127.0.0.1:'+port+'/'+jn+'?sslmode=disable',AG_NATIVE_PROVIDER_JOINED_KERNEL_DSN:'postgres://postgres@127.0.0.1:'+port+'/'+jk+'?sslmode=disable',AG_NATIVE_PROVIDER_JOINED_BINARY:joined+'/fixture',AG_NATIVE_PROVIDER_JOINED_GO:option('--go'),AG_NATIVE_PROVIDER_JOINED_GATEWAY_BASE_SHA:gatewayCommit,AG_NATIVE_PROVIDER_JOINED_GATEWAY_SOURCE_SHA256:b.gatewaySourceArchiveSHA256},180_000);const joinedReceipt=JSON.parse(joinedOutput) as Record<string,unknown>;check(joinedReceipt.phase==='completed'&&joinedReceipt.contract==='gateway-native-provider-joined/v1'&&joinedReceipt.nativeHead===nativeCommit&&joinedReceipt.liveProviderAccount===false,'joined-receipt');reports.joined={passed:true};
    check(JSON.stringify(b.sourceHashes)===JSON.stringify(sourceHashes()),'final-source-change');
    runtimeReceipt={kind:'gateway-native4-runtime/v1',gatewayCommit,nativeCommit,node:process.version,pgImage,buildReceipt:hash(join(build,'build.json')),reports,tapEvidence,pythonPidfd,nodeExecutableSHA256:hash(process.execPath),externalProviderCalls:false};
  } finally {
    if(!stopped)await run('gosu',['postgres',join(pg,'pg_ctl'),'-D',pgdata,'-m','fast','-w','stop']);
    const status=await exec.run({command:'gosu',args:['postgres',join(pg,'pg_ctl'),'-D',pgdata,'status'],cwd:gateway,environment:env,timeoutMs:5000,strictUtf8:true});check(status.exitCode===3&&status.signal===null&&status.stdout.includes('no server running'),'pg-stop-unproven');
  }
  check(runtimeReceipt,'runtime-incomplete');json(join(output,'runtime.json'),runtimeReceipt);
}
try{check(['build','runtime'].includes(phase),'phase');if(phase==='build')await build();else await runtime();}
catch(error){process.stderr.write(JSON.stringify({outcome:'fail',phase,step,lastFailure,code:isProcessRuntimeError(error)?'process-'+error.code:error instanceof Error&&/^[a-z0-9-]+$/.test(error.message)?error.message:'operator-failed'})+'\n');process.exitCode=1;}
