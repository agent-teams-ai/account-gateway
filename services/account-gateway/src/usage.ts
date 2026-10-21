import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { usageObservation } from '@agent-teams/account-gateway/contracts';
import type { UsageObservation, UsagePage, UsageQuery } from '@agent-teams/account-gateway/contracts';
import { KernelError } from './domain.ts';
import type { TrustedContext } from './domain.ts';

export interface UsageJournal {
  observe(context: TrustedContext, executionRef: string, requestRef: string): Promise<UsageObservation | null>;
  append(context: TrustedContext, fact: UsageObservation): Promise<void>;
  list(context: TrustedContext, query: UsageQuery): Promise<UsagePage>;
}
// Every writer holds the counter lock through commit. A captured high water
// therefore cannot hide an earlier uncommitted insert or late correction.
export class PostgresUsageJournal implements UsageJournal {
  readonly #pool: Pool; readonly #key: Uint8Array;
  constructor(pool: Pool, key: Uint8Array) { this.#pool = pool; this.#key = createHash('sha256').update(key).update('usage-cursor-v1').digest(); }
  async observe(context: TrustedContext, executionRef: string, requestRef: string): Promise<UsageObservation | null> {
    const result = await this.#pool.query('SELECT fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND execution_ref=$2 AND request_ref=$3 ORDER BY revision DESC LIMIT 1',
      [context.consumerId, executionRef, requestRef]);
    return result.rows.length ? usageObservation.parse(result.rows[0].fact) : null;
  }
  async append(context: TrustedContext, input: UsageObservation): Promise<void> {
    const fact = usageObservation.parse(input), db = await this.#pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton FOR UPDATE');
      const previous = await db.query('SELECT fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND execution_ref=$2 AND request_ref=$3 AND revision=$4',
        [context.consumerId, fact.executionRef, fact.requestRef, fact.revision]);
      if (previous.rows.length) {
        if (JSON.stringify(usageObservation.parse(previous.rows[0].fact)) !== JSON.stringify(fact)) throw new KernelError('conflict');
      } else {
        const position = await db.query('UPDATE ag_kernel.usage_feed_counter SET value=value+1 WHERE singleton RETURNING value');
        await db.query('INSERT INTO ag_kernel.usage_observations(position,consumer,execution_ref,request_ref,revision,fact) VALUES($1,$2,$3,$4,$5,$6)',
          [position.rows[0].value, context.consumerId, fact.executionRef, fact.requestRef, fact.revision, fact]);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  #cursor(consumer: string, after: string, high: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify([consumer, after, high])), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  #readCursor(consumer: string, cursor: string): readonly [string, string] {
    let values: unknown;
    try {
      if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length < 29) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      values = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    } catch { throw new KernelError('invalid'); }
    if (!Array.isArray(values) || values.length !== 3 || values[0] !== consumer ||
      values.slice(1).some(v => typeof v !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(v))) throw new KernelError('denied');
    if (BigInt(values[1]) > BigInt(values[2])) throw new KernelError('invalid');
    return [values[1], values[2]];
  }
  async list(context: TrustedContext, query: UsageQuery): Promise<UsagePage> {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new KernelError('invalid');
    let after = '0', high: string;
    if (query.afterCursor) {
      const values = this.#readCursor(context.consumerId, query.afterCursor);
      after = values[0]; high = values[1];
      // A completed page begins a new captured window on its next request.
      if (after === high && !query.highWaterCursor) high = String((await this.#pool.query('SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton')).rows[0].value);
    } else high = String((await this.#pool.query('SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton')).rows[0].value);
    if (query.highWaterCursor) {
      const bound = this.#readCursor(context.consumerId, query.highWaterCursor);
      if (bound[0] !== bound[1] || (query.afterCursor && high !== bound[1]) || BigInt(after) > BigInt(bound[1])) throw new KernelError('invalid');
      high = bound[1];
    }
    const rows = await this.#pool.query('SELECT position,fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND position>$2 AND position<=$3 ORDER BY position LIMIT $4',
      [context.consumerId, after, high, limit]);
    // Facade control responses have a hard 64KiB bound. A full count-based
    // page can exceed it with valid maximal references; never skip those rows.
    const observations: UsageObservation[] = [];
    let bytes = 0, last = after;
    for (const row of rows.rows) {
      const fact = usageObservation.parse(row.fact), size = Buffer.byteLength(JSON.stringify(fact)) + 1;
      if (bytes + size > 55_000) break;
      observations.push(fact); bytes += size; last = String(row.position);
    }
    if (observations.length === rows.rows.length && rows.rows.length < limit) last = high;
    const highWaterCursor = query.highWaterCursor ?? this.#cursor(context.consumerId, high, high);
    return { observations, nextCursor: last === high ? highWaterCursor : this.#cursor(context.consumerId, last, high), highWaterCursor };
  }
}

// Bounded transient parsing only: neither prompt nor response body is persisted.
// Missing/invalid terminal metadata stays unknown; transport success is not usage.
export class ResponsesUsageCapture {
  #pending = ''; #decoder = new TextDecoder(); #dropped = false;
  #usage: Pick<UsageObservation, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens'> =
    { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null };
  push(bytes: Uint8Array): void {
    if (this.#dropped) return;
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    while (this.#pending.includes('\n')) {
      const end = this.#pending.indexOf('\n'), line = this.#pending.slice(0, end).replace(/\r$/, '');
      this.#pending = this.#pending.slice(end + 1);
      if (line.length > 1_048_576) { this.#dropped = true; this.#pending = ''; return; }
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5));
        if (event.type !== 'response.completed') continue;
        const u = event.response?.usage;
        const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
        this.#usage = { inputTokens: numeric(u?.input_tokens), outputTokens: numeric(u?.output_tokens),
          cachedInputTokens: numeric(u?.input_tokens_details?.cached_tokens), reasoningTokens: numeric(u?.output_tokens_details?.reasoning_tokens) };
        if (this.#usage.cachedInputTokens !== null && (this.#usage.inputTokens === null || this.#usage.cachedInputTokens > this.#usage.inputTokens)) this.#usage.cachedInputTokens = null;
        if (this.#usage.reasoningTokens !== null && (this.#usage.outputTokens === null || this.#usage.reasoningTokens > this.#usage.outputTokens)) this.#usage.reasoningTokens = null;
      } catch { /* malformed usage cannot become a zero */ }
    }
    if (this.#pending.length > 1_048_576) { this.#dropped = true; this.#pending = ''; }
  }
  snapshot() { return { ...this.#usage, completeness: 'partial' as const }; }
}

export interface NativeUsage {
  source: 'native_provider_response'; state: 'unknown' | 'partial' | 'complete';
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number;
  costState: 'unknown'; finalized: boolean;
}
export function nativeUsage(value: unknown): NativeUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KernelError('invalid');
  const r = value as Record<string, unknown>;
  const required = ['source','state','costState','finalized'], optional = ['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'];
  if (required.some(key => !Object.hasOwn(r, key)) || Object.keys(r).some(key => !required.includes(key) && !optional.includes(key))) throw new KernelError('invalid');
  if (r.source !== 'native_provider_response' || !['unknown','partial','complete'].includes(r.state as string) ||
      r.costState !== 'unknown' || typeof r.finalized !== 'boolean') throw new KernelError('invalid');
  for (const key of ['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'])
    if (r[key] !== undefined && (!Number.isSafeInteger(r[key]) || (r[key] as number) < 0)) throw new KernelError('invalid');
  if (r.state === 'complete' && (r.inputTokens === undefined || r.outputTokens === undefined) ||
      r.cachedInputTokens !== undefined && (r.inputTokens === undefined || (r.cachedInputTokens as number) > (r.inputTokens as number)) ||
      r.reasoningOutputTokens !== undefined && (r.outputTokens === undefined || (r.reasoningOutputTokens as number) > (r.outputTokens as number))) throw new KernelError('invalid');
  return Object.freeze({ ...r }) as unknown as NativeUsage;
}
