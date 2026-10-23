// Bounded, synthetic qualification data. Never serialize credentials or bodies.
import { createHash } from 'node:crypto';

export const bounds = Object.freeze({ wallMs: 900_000, drainMs: 60_000, attempts: 2048,
  executions: 96, capPreparations: 130, accounts: 32, streamBytes: 8_388_608,
  totalBytes: 536_870_912, artifactBytes: 67_108_864 });
export const scenarios = ['smoke', 'short-steps', 'long-steps', 'arrivals', 'slow-reader',
  'cancellation', 'overload-recovery', 'bearer-cap'] as const;
export type Scenario = typeof scenarios[number];
export type Outcome = 'pass' | 'fail' | 'inconclusive';
export interface Attempt {
  requestId: string; executionRef: string; accountRef: string; scenario: Scenario;
  mode: 'sdk' | 'raw-tcp'; offeredAt: number; startedAt: number; firstByteAt?: number;
  finishedAt?: number; bytes: number; response?: 'stream' | 'status' | 'error' | 'disconnect';
  error?: string; effect?: string; sqlCode?: string; occupied?: boolean;
  preclaimRefused?: boolean;
  intentionalCancel?: 'raw-disconnect' | 'sdk-abort' | 'sdk-close'; validatedStream?: boolean;
  nativeClosed?: boolean; nativeAcknowledged?: boolean; exactProof?: boolean; providerEntries?: number;
}
export interface LedgerEvent {
  event: 'entry' | 'headers' | 'blocked' | 'drain' | 'end' | 'close' | 'budget' | 'violation';
  requestId: string; at: number; bytes: number; sequence: number;
}
export function check(value: unknown, phase: string): asserts value {
  if (!value) throw new Error('load:' + phase);
}
export function identifier(runId: string, seed: number, sequence: number): string {
  const h = createHash('sha256').update(runId + ':' + seed + ':' + sequence).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}
export function entries(events: readonly LedgerEvent[], requestId: string): number {
  return events.filter(e => e.event === 'entry' && e.requestId === requestId).length;
}
export function reconcile(attempt: Attempt, events: readonly LedgerEvent[]): string[] {
  const count = entries(events, attempt.requestId), faults: string[] = [];
  if (count > 1) faults.push('duplicate-provider-entry');
  if (attempt.effect === 'not_dispatched' && count !== 0) faults.push('denial-entered-provider');
  if (attempt.effect === 'completed' && count !== 1) faults.push('completed-without-one-entry');
  if (count === 1 && !attempt.effect) faults.push('provider-entry-without-durable-effect');
  if (!attempt.effect && count === 0 && !attempt.preclaimRefused) faults.push('unclassified-attempt');
  if (!attempt.intentionalCancel && attempt.effect && attempt.effect !== 'not_dispatched' &&
      (attempt.effect !== 'completed' || attempt.response !== 'stream' || !attempt.validatedStream)) faults.push('unexpected-effect-or-client-stream-failure');
  if (attempt.occupied) faults.push('occupied-after-drain');
  if ((count === 1 || attempt.effect && attempt.effect !== 'not_dispatched') &&
      (!attempt.exactProof || !attempt.nativeClosed || !attempt.nativeAcknowledged)) faults.push('missing-exact-native-closure');
  return faults;
}
export function safeError(error: unknown): string {
  if (error instanceof Error && /^load:[a-z0-9-]{1,100}$/.test(error.message)) return error.message.slice(5);
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' &&
      /^[a-z_]{1,40}$/.test(error.code)) return error.code;
  return 'unclassified-failure';
}
export async function bounded<T>(work: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('load:' + phase)), ms);
  })]); } finally { clearTimeout(timer); }
}
export interface Proof {
  executionRef: string; requestRef: string; worker: string; token: string;
  native: { originRef: string; engineIncarnation: string; requestNonce: string; generation: string };
}
export function closureProjection(value: unknown, consumerId: string, p: Proof) {
  const r = value as Record<string, unknown>, proof = r?.proof as Proof | undefined;
  const native = r?.native as Proof['native'] | undefined, l = r?.lifetime as Record<string, unknown> | undefined;
  const exactProof = !!proof && r.consumerId === consumerId && r.executionRef === p.executionRef && r.requestRef === p.requestRef &&
    ['executionRef','requestRef','worker','token'].every(k => proof[k as keyof Proof] === p[k as keyof Proof]) &&
    !!native && !!proof.native && Object.keys(p.native).every(k => native[k as keyof Proof['native']] === p.native[k as keyof Proof['native']] &&
      proof.native[k as keyof Proof['native']] === p.native[k as keyof Proof['native']]);
  return { exactProof, nativeClosed: !!l && r.phase === 'closed' && l.contextDone === true &&
    l.forwardingReturned === true && l.bodyKnown === true && l.bodyClosed === true && l.closeFailed === false,
  nativeAcknowledged: r?.acknowledged === true };
}
