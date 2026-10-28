// Only sanitized operator receipts cross from private root output to runner artifacts.
import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, chownSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const keys = {
  'runtime.json': ['kind','gatewayCommit','nativeCommit','node','pgImage','buildReceipt','reports','tapEvidence','pythonPidfd','nodeExecutableSHA256','externalProviderCalls'],
  'failure.json': ['outcome','phase','primary','cleanup'],
  'cleanup.json': ['kind','postgresStartAttempted','postgresStopVerified','stopCommand','statusBefore','statusAfter'],
} as const;
export function validateReceipt(name: keyof typeof keys, bytes: Buffer): void {
  if (bytes.length > 524288) throw new Error('receipt-size');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !(keys[name] as readonly string[]).includes(k))) throw new Error('receipt-schema');
  const rejectPrivateFields=(item:unknown,depth=0):void=>{if(depth>16)throw new Error('receipt-depth');if(item&&typeof item==='object'){for(const [field,child]of Object.entries(item)){if(/credential|token|secret|password|dsn|prompt|body|bearer|config|^(?:stdout|stderr|stack|message|keys?)$/i.test(field))throw new Error('receipt-private-field');rejectPrivateFields(child,depth+1);}}};rejectPrivateFields(value);
  const record = value as Record<string,unknown>;
  if (name === 'failure.json' ? record.outcome !== 'fail' || !record.primary :
      record.kind !== (name === 'runtime.json' ? 'gateway-native4-runtime/v1' : 'gateway-native4-cleanup/v1')) throw new Error('receipt-kind');
}
export function stage(source: string, destination: string, uid: number, gid: number): void {
  if (process.geteuid?.() !== 0 || ![source,destination].every(p=>isAbsolute(p)&&resolve(p)===p) ||
      !source.endsWith('/container-output/result') || !destination.endsWith('/receipt-staging') ||
      dirname(dirname(source)) !== dirname(destination) || !Number.isSafeInteger(uid) || uid <= 0 ||
      !Number.isSafeInteger(gid) || gid < 0 || existsSync(destination)) throw new Error('staging-input');
  mkdirSync(destination,{mode:0o700});chownSync(destination,uid,gid);
  const receipts:Record<string,string>={};
  if (existsSync(source)) {
    const directory=lstatSync(source);
    if (!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==0||(directory.mode&0o022)!==0) throw new Error('receipt-directory');
    for (const name of Object.keys(keys) as (keyof typeof keys)[]) {
      const file=join(source,name);if(!existsSync(file))continue;
      const stat=lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==0||(stat.mode&0o777)!==0o600)throw new Error('receipt-custody');
      const bytes=readFileSync(file);validateReceipt(name,bytes);
      const target=join(destination,name);writeFileSync(target,bytes,{flag:'wx',mode:0o600});chownSync(target,uid,gid);
      receipts[name]=createHash('sha256').update(bytes).digest('hex');
    }
  }
  const manifest=join(destination,'staging.json');writeFileSync(manifest,JSON.stringify({kind:'gateway-native4-receipt-staging/v1',receipts})+'\n',{flag:'wx',mode:0o600});chownSync(manifest,uid,gid);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {const args=process.argv.slice(2);if(args.length!==4)throw new Error('staging-input');stage(args[0]!,args[1]!,Number(args[2]),Number(args[3]));}
  catch(error){process.stderr.write(JSON.stringify({outcome:'fail',code:error instanceof Error&&/^[a-z-]+$/.test(error.message)?error.message:'staging-failed'})+'\n');process.exitCode=1;}
}
