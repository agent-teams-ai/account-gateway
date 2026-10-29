// Finite TEST decoder for the exact zero-exit joined harness JSONL contract.
export interface JoinedBinding { nativeHead:string;gatewayBaseHead:string;gatewaySourceArchiveSHA256:string;nativeBinarySHA256:string; }
const flags=['nativeHTTP','gatewayFacadeAndSDK','actualPostgreSQL','providerShapedFixture','controlledTextAndFunctionToolRoundTrip','dynamicOpenRouterDiscoveryAndDispatch','dynamicOpenRouterAuthoritativeRemoval','dynamicOpenRouterQualifiedReasoning','dynamicOpenRouterImmutableAnchor','minimaxReasoningContentRoundTrip','reconnectRetainsAccount','canonicalErasure','grokRefresh','wrongOwnerDenied'] as const;
function check(value:unknown):asserts value {if(!value)throw new Error('joined-receipt');}
function object(value:unknown):Record<string,unknown>{check(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
export function qualifyJoined(output:string,binding:JoinedBinding):void {
  check(Buffer.byteLength(output)<=131072);const lines=output.split(/\r?\n/).filter(line=>line.trim()!=='');check(lines.length===2);
  let values:unknown[];try{values=lines.map(line=>JSON.parse(line) as unknown);}catch{throw new Error('joined-receipt');}
  const progress=object(values[0]),receipt=object(values[1]);check(progress.phase==='enrollment-safe-counters'&&receipt.phase==='completed');
  check(Object.keys(progress).every(k=>['phase','kimi','glm','minimax','grok','openrouter','unexpected','openrouterModelGets'].includes(k)));
  for(const name of ['kimi','glm','minimax','grok','openrouter']){const stats=object(progress[name]);check(Object.keys(stats).every(k=>['dispatches','quotaGets','exchanges','refreshes','functionCalls','functionOutputs','customCalls','customOutputs'].includes(k)));check(Object.values(stats).every(v=>Number.isSafeInteger(v)&&Number(v)>=0));}
  check(object(progress.grok).exchanges===1&&object(progress.grok).refreshes===1&&progress.unexpected===0&&Number.isSafeInteger(progress.openrouterModelGets));
  check(receipt.contract==='gateway-native-provider-joined/v1'&&receipt.liveProviderAccount===false&&receipt.inertReadProviderCalls===0&&flags.every(k=>receipt[k]===true));
  for(const key of ['nativeHead','gatewayBaseHead','gatewaySourceArchiveSHA256','nativeBinarySHA256'] as const)check(receipt[key]===binding[key]);
}
