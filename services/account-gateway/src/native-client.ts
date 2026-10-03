import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { KernelError, identifier, uuid } from './domain.ts';
import { physicalCandidate } from './management.ts';
import type { CandidateJournal, CandidateMapping, CandidateNative, NativeReadback, PhysicalCandidate } from './management.ts';

export type NativeFailureCode = 'unavailable' | 'deadline' | 'bounded' | 'redirect' | 'invalid_readback' | 'denied';
export class NativeFailure extends Error {
  readonly code: NativeFailureCode;
  // Any request failure may be effected. HTTP status alone never asserts NoEffect.
  readonly classification = 'uncertain';
  constructor(code: NativeFailureCode) { super(code); this.code = code; }
}
// Existing private Go wire, supplied at native source 16d621c2. This is not SDK v1.
const candidatesPath = '/private/native/v1/candidates';
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) throw new NativeFailure('invalid_readback');
  return value as Record<string, unknown>;
}
function decode(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // JSON.parse chooses the last duplicate. Reject decoded duplicate member names
  // (including escaped aliases) before accepting any physical identity or ACK.
  let position = 0;
  const space = (): void => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const c = text[position++];
      if (c === '\\') position++;
      else if (c === '"') return JSON.parse(text.slice(start,position)) as string;
    }
    throw new NativeFailure('invalid_readback');
  };
  const value = (depth: number): void => {
    space();
    if (text[position] === '{') {
      if (depth > 1) throw new NativeFailure('invalid_readback');
      position++; space(); const keys = new Set<string>();
      if (text[position] === '}') { position++; return; }
      while (position < text.length) {
        if (text[position] !== '"') throw new NativeFailure('invalid_readback');
        const key = string();
        if (keys.has(key)) throw new NativeFailure('invalid_readback');
        keys.add(key); space();
        if (text[position++] !== ':') throw new NativeFailure('invalid_readback');
        value(depth + 1); space();
        const next = text[position++];
        if (next === '}') return;
        if (next !== ',') throw new NativeFailure('invalid_readback');
        space();
      }
      throw new NativeFailure('invalid_readback');
    }
    if (text[position] === '[') throw new NativeFailure('invalid_readback');
    if (text[position] === '"') { string(); return; }
    const start = position;
    while (position < text.length && !/[\s,}]/.test(text[position])) position++;
    if (position === start) throw new NativeFailure('invalid_readback');
  };
  value(0); space();
  if (position !== text.length) throw new NativeFailure('invalid_readback');
  return JSON.parse(text) as unknown;
}
function readback(bytes: Buffer): NativeReadback {
  try {
    const r = object(decode(bytes),['descriptor','name','state','group_free','schedulable','probes_enabled']);
    const d = object(r.descriptor,['account_id','generation','created_at','profile','base_url','model']);
    if (typeof r.name !== 'string' || Buffer.byteLength(r.name) < 1 || Buffer.byteLength(r.name) > 400 ||
        !['inactive','active'].includes(r.state as string) || r.group_free !== true ||
        r.schedulable !== false || r.probes_enabled !== false) throw new NativeFailure('invalid_readback');
    const descriptor = physicalCandidate({ generation: d.generation as string,
      nativePhysicalIdentity: d.generation as string, nativeId: d.account_id as number,
      createdAt: d.created_at as string, profile: d.profile as string, baseURL: d.base_url as string, model: d.model as string });
    return Object.freeze({ ...descriptor,state: r.state as 'inactive' | 'active' });
  } catch { throw new NativeFailure('invalid_readback'); }
}
function wireDescriptor(d: PhysicalCandidate): object {
  return { account_id: d.nativeId,generation: d.generation,created_at: d.createdAt,
    profile: d.profile,base_url: d.baseURL,model: d.model };
}
export class NativeManagementClient implements CandidateNative {
  readonly #origin: URL;
  readonly #consumer: string;
  readonly #control: string;
  readonly #deadlineMs: number;
  readonly #bodyBytes: number;
  readonly #headerBytes: number;
  constructor(options: { origin: string; consumerId: string; controlCredential: string;
    deadlineMs?: number; bodyBytes?: number; headerBytes?: number }) {
    let origin: URL;
    try { origin = new URL(options.origin); } catch { throw new KernelError('invalid'); }
    if (!(origin.protocol === 'https:' || (origin.protocol === 'http:' &&
        ['127.0.0.1','[::1]'].includes(origin.hostname))) || origin.pathname !== '/' ||
        origin.username || origin.password || origin.search || origin.hash) throw new KernelError('invalid');
    identifier(options.consumerId);
    if (typeof options.controlCredential !== 'string' || options.controlCredential.length < 1 ||
        options.controlCredential.length > 2048 || !/^[A-Za-z0-9._~+/-]+=*$/.test(options.controlCredential)) throw new KernelError('invalid');
    const deadlineMs = options.deadlineMs ?? 5000, bodyBytes = options.bodyBytes ?? 65_536, headerBytes = options.headerBytes ?? 16_384;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000 ||
        !Number.isInteger(bodyBytes) || bodyBytes < 1 || bodyBytes > 262_144 ||
        !Number.isInteger(headerBytes) || headerBytes < 1024 || headerBytes > 16_384) throw new KernelError('invalid');
    this.#origin = origin; this.#consumer = options.consumerId; this.#control = options.controlCredential;
    this.#deadlineMs = deadlineMs; this.#bodyBytes = bodyBytes; this.#headerBytes = headerBytes;
  }
  private scope(scope: CandidateJournal): void {
    if (scope.consumerId !== this.#consumer) throw new NativeFailure('denied');
    uuid(scope.generation); uuid(scope.accountRef); identifier(scope.ownerRef);
  }
  private async call(method: 'POST' | 'GET' | 'PUT', path: string, value?: unknown): Promise<Buffer> {
    let body: Buffer | undefined;
    try {
      body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
      if (body && body.length > 16_384) throw new NativeFailure('bounded');
    } catch { throw new NativeFailure('bounded'); }
    return new Promise<Buffer>((resolve, reject) => {
      let finished = false;
      const finish = (error?: NativeFailure, bytes?: Buffer): void => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(bytes ?? Buffer.alloc(0));
      };
      const send = this.#origin.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(this.#origin, {
        method, path, agent: false, maxHeaderSize: this.#headerBytes,
        headers: { authorization: 'Bearer ' + this.#control, accept: 'application/json',
          connection: 'close', ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) },
      });
      req.maxHeadersCount = 64;
      const timer = setTimeout(() => { finish(new NativeFailure('deadline')); req.destroy(); }, this.#deadlineMs);
      req.on('error', () => finish(new NativeFailure('unavailable')));
      req.on('response', res => {
        // Node's maxHeadersCount truncates headers; independently reject overflow.
        if (res.rawHeaders.length > 128) {
          finish(new NativeFailure('bounded')); res.destroy(); req.destroy(); return;
        }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(new NativeFailure(status >= 300 && status < 400 ? 'redirect' : 'unavailable'));
          res.destroy(); req.destroy(); return;
        }
        const chunks: Buffer[] = []; let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.#bodyBytes) { finish(new NativeFailure('bounded')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('aborted', () => finish(new NativeFailure('unavailable')));
        res.on('error', () => finish(new NativeFailure('unavailable')));
        res.on('end', () => finish(undefined, Buffer.concat(chunks)));
      });
      // No redirect handler, reuse agent, retry, provider route or consumer bearer.
      if (body) req.end(body); else req.end();
    });
  }
  async create(input: CandidateJournal, displayName: string, apiKey: string): Promise<void> {
    const scope = { consumerId: input.consumerId, generation: input.generation, accountRef: input.accountRef,
      ownerRef: input.ownerRef, profile: input.profile.profile };
    if (scope.consumerId !== this.#consumer) throw new NativeFailure('denied');
    uuid(scope.generation); uuid(scope.accountRef); identifier(scope.ownerRef); identifier(scope.profile, 64);
    if (typeof displayName !== 'string' || !displayName.isWellFormed() || displayName.length < 1 || displayName.length > 128 || Buffer.byteLength(displayName) > 400 || typeof apiKey !== 'string' ||
        !apiKey.isWellFormed() || Buffer.byteLength(apiKey) < 1 || Buffer.byteLength(apiKey) > 4096 || apiKey.trim() !== apiKey) throw new NativeFailure('bounded');
    await this.call('POST', candidatesPath, { generation: scope.generation, profile: scope.profile,
      name: displayName, api_key: apiKey, owner_ref: scope.ownerRef, account_ref: scope.accountRef });
  }
  async read(input: CandidateJournal): Promise<readonly NativeReadback[]> {
    this.scope(input);
    const generation = input.generation;
    const result = readback(await this.call('GET', candidatesPath + '/' + generation));
    if (result.generation !== generation) throw new NativeFailure('invalid_readback');
    return Object.freeze([result]);
  }
  private descriptor(input: CandidateMapping): PhysicalCandidate {
    this.scope(input);
    const d = physicalCandidate(input.descriptor);
    if (d.generation !== input.generation || d.nativePhysicalIdentity !== input.generation ||
        d.profile !== input.profile.profile || d.baseURL !== input.profile.baseURL || d.model !== input.profile.model) throw new NativeFailure('denied');
    return d;
  }
  async setState(input: CandidateMapping, state: 'active' | 'inactive'): Promise<void> {
    const d = this.descriptor(input);
    if (!['active','inactive'].includes(state)) throw new NativeFailure('denied');
    // The PUT ACK itself does not authorize promotion; orchestration uses an exact GET.
    const response = readback(await this.call('PUT', candidatesPath + '/' + d.generation,
      { descriptor: wireDescriptor(d),state }));
    if (response.state !== state || response.generation !== d.generation || response.nativeId !== d.nativeId ||
        response.createdAt !== d.createdAt || response.profile !== d.profile || response.baseURL !== d.baseURL || response.model !== d.model) throw new NativeFailure('invalid_readback');
  }
  async erase(input: CandidateMapping): Promise<void> {
    const d = this.descriptor(input);
    const bytes = await this.call('POST', candidatesPath + '/' + d.generation + '/erase', { descriptor: wireDescriptor(d) });
    try {
      const ack = object(decode(bytes),['state','credentials_erased']);
      if (ack.state !== 'tombstoned' || ack.credentials_erased !== true) throw new NativeFailure('invalid_readback');
    } catch { throw new NativeFailure('invalid_readback'); }
  }
}
