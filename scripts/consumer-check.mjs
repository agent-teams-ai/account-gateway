// Run this copied script from an independently installed disposable consumer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, realpathSync } from 'node:fs';
const { channel } = await import('node:diagnostics_channel');
let networkRequests=0;
const observe=()=>{networkRequests++};
channel('undici:request:create').subscribe(observe);
const sdk = await import('@agent-teams/account-gateway/http');
const wire = await import('@agent-teams/account-gateway/contracts');
const gm = await import('@agent-teams/account-gateway/get-modular');
assert.equal(networkRequests,0,'importing declarations and entrypoints must be inert');
channel('undici:request:create').unsubscribe(observe);
assert.equal(wire.account.safeParse({}).success, false);
// Both independently installed archives must expose the selected preparation contract.
const selected = {kind:'execution',executionRef:'execution-selected',accountRef:'account-b',authorizationEpoch:17,deadline:'2026-10-03T23:00:00Z',state:'active'};
const prepared = {operationRef:'prepare-selected',state:'applied',result:selected};
assert.deepEqual(wire.preparationOperation.parse(prepared), prepared);
assert.deepEqual(wire.operation.parse(prepared), prepared);
for (const field of ['accountRef','authorizationEpoch']) {
 const incomplete={...selected};delete incomplete[field];
 assert.equal(wire.preparationOperation.safeParse({...prepared,result:incomplete}).success,false);
 assert.equal(wire.operation.safeParse({...prepared,result:incomplete}).success,false);
}
assert.equal(wire.operation.safeParse({...prepared,result:{...selected,nativeDescriptor:'private-sentinel'}}).success,false);
assert.equal(typeof sdk.createManagementClient, 'function');
assert.equal(typeof sdk.createLifecycleClient, 'function');
assert.equal(wire.LIFECYCLE_CAPABILITY_CONTRACT, 'account-gateway/account-lifecycle/v2');
assert.equal(wire.LIFECYCLE_CLIENT_CONTRACT, 'account-gateway-client/account-lifecycle/v2');
assert.equal(typeof wire.lifecycleOperation.parse, 'function');
assert.equal(typeof wire.lifecycleAccount.parse, 'function');
assert.equal(typeof gm.constructExecutionClient, 'function');
assert.equal('connect' in sdk.createExecutionClient({ origin:'http://127.0.0.1:1', role:'execution', token:'fixture-only' }), false);
const resolved = realpathSync(new URL(import.meta.resolve('@agent-teams/account-gateway/http')));
assert.ok(resolved.startsWith(process.cwd()+'/node_modules/'), 'SDK must be installed locally without workspace/source link');
const blocked = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '-e', "import '@agent-teams/account-gateway/http'"], { encoding:'utf8' });
assert.notEqual(blocked.status, 0);
assert.match(blocked.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
// Consumer domain owns this port and imports no SDK/framework DTO.
writeFileSync('consumer-port.mts', `export interface ConnectionReader { owner(reference: string): Promise<string> }
export async function readOwnedConnection(port: ConnectionReader, reference: string, expectedOwner: string): Promise<string> {
 const owner=await port.owner(reference);
 if(owner!==expectedOwner) throw new Error('Connection owner mismatch');
 return reference;
}
`);
writeFileSync('closure.mts', `import type {Account, Operation, Prepare, ListQuery} from '@agent-teams/account-gateway/contracts';
import {createExecutionClient, createManagementClient} from '@agent-teams/account-gateway/http';
import type {ManagementConfig, LifecycleConfig, LifecycleClient} from '@agent-teams/account-gateway/http';
import {createLifecycleClient} from '@agent-teams/account-gateway/http';
import {LIFECYCLE_CAPABILITY_CONTRACT, LIFECYCLE_CLIENT_CONTRACT, lifecycleAccount, lifecycleOperation} from '@agent-teams/account-gateway/contracts';
import type {LifecycleAccount, LifecycleOperation} from '@agent-teams/account-gateway/contracts';
import {constructManagementClient, bindExecutionFactory} from '@agent-teams/account-gateway/get-modular';
import type {ConnectionReader} from './consumer-port.mjs';
export {readOwnedConnection} from './consumer-port.mjs';
// Only this outer adapter sees transport configuration and DTOs.
export function readerFor(settings: ManagementConfig): ConnectionReader {
 const client=createManagementClient(settings);
 return {owner: async reference => (await client.get(reference)).ownerRef};
}
// Actual dashboard composition also constructs the lifecycle reader even while
// writes are disabled. Preserve its authenticated owner projection and exports.
export function lifecycleReaderFor(settings: ManagementConfig): ConnectionReader {
 const client=createLifecycleClient({...settings,capability:LIFECYCLE_CAPABILITY_CONTRACT,clientContract:LIFECYCLE_CLIENT_CONTRACT});
 return {owner:async reference=>(await client.get(reference)).ownerRef};
}
export type LifecycleClosure=[LifecycleConfig,LifecycleClient,LifecycleAccount,LifecycleOperation,typeof lifecycleAccount,typeof lifecycleOperation];
if(false) {
 const run=createExecutionClient({origin:'http://127.0.0.1:1',role:'execution',token:'fixture'});
 // @ts-expect-error execution role cannot administer accounts
 run.connect({});
 // @ts-expect-error management config cannot be an execution role
 createManagementClient({origin:'http://127.0.0.1:1',role:'execution',token:'fixture'});
}
// Declaration closure must expose required selected fields after result discrimination.
export function selectedIdentity(operation: Operation): {accountRef: string; authorizationEpoch: number} | undefined {
 if(operation.state!=='applied' || operation.result?.kind!=='execution') return undefined;
 return {accountRef:operation.result.accountRef,authorizationEpoch:operation.result.authorizationEpoch};
}
export type Closure=[Account, Operation, Prepare, ListQuery, typeof constructManagementClient, typeof bindExecutionFactory];
`);
const typed = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--strict', '--skipLibCheck', 'false', '--types', 'node', '--outDir', 'compiled', 'closure.mts'], { stdio:'inherit' });
assert.equal(typed.status, 0);
console.log('PASS installed runtime exports, browser denial, TypeScript closure and typed role separation');
