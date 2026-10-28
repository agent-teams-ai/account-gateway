import type { NodeDiagnostic } from './node-diagnostics.ts';
import { isProcessRuntimeError } from 'node-or-bun';
export interface Failure {
  code: string;
  step: string;
  guard?: { path: string; uid: number; gid: number; mode: string; symlink: boolean };
  process?: { exitCode: number | null; signal: string | null; stdoutSha256: string|null; stderrSha256: string|null; stdoutBytes?:number;stderrBytes?:number;capture?:'complete'|'partial'|'unavailable';node?:NodeDiagnostic; safePhase?: string; fixturePhase?: string };
}
export class QualificationFailure extends Error {
  readonly facts: Failure;
  constructor(facts: Failure) { super(facts.code); this.facts = facts; }
}
export function safeFailure(error: unknown, step: string): Failure {
  if (error instanceof QualificationFailure) return error.facts;
  if (isProcessRuntimeError(error)) return { code: 'process-' + error.code, step };
  const code = error instanceof Error && /^[a-z0-9-]{1,128}$/.test(error.message) ? error.message : 'operator-failed';
  return { code, step };
}
export function failureOutcome(primary: Failure | undefined, cleanup: Failure | undefined): { primary: Failure; cleanup?: Failure } {
  const selected = primary ?? cleanup;
  if (!selected) throw new Error('missing-failure');
  return { primary: selected, ...(cleanup ? { cleanup } : {}) };
}
