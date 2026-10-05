import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { approvedLimits, boundedFacts, defaults, identifier, integer } from './domain.ts';
import type { ApprovedLimits, DurableFactBounds } from './domain.ts';
import { FacadeBearers } from './facade.ts';
import type { ManagementBearer, RunControlBearer } from './facade.ts';
import { strictJSON } from './facade-ingress.ts';
import { object } from './native-wire.ts';
import { physicalCandidate, codexOAuthProfile } from './management.ts';

export class ServiceError extends Error {
  readonly code: 'config_denied' | 'startup_denied' | 'runtime_denied' | 'shutdown_pending';
  constructor(code: ServiceError['code']) { super(code); this.code = code; }
}
export interface ServiceConfig {
  readonly kernelDSN: string;
  // Required operator input; implementation defaults are not qualified caps.
  readonly durableFacts: Readonly<DurableFactBounds>;
  readonly facadeOrigin: string;
  readonly callbackOrigin: string;
  readonly native: Readonly<{ executable: string; sha256: string; bootstrapFile: string;
    authorityDir: string; origin: string; originRef: string; uid: number; gid: number }>;
  readonly consumer: Readonly<{ consumerId: string; managementCredential: string;
    executionCredential: string; cleanupCredential: string; callbackCredential: string }>;
  readonly profile: Readonly<{ profile: string; model: string; baseURL: string;
    qualificationRef: string; limits: Readonly<ApprovedLimits>; providerTokenUpperBound: number }>;
  readonly bearers: readonly (ManagementBearer | RunControlBearer)[];
  readonly keys: Readonly<{ intentAEAD: string; intentHMAC: string; facadeHMAC: string }>;
  // Explicit source opt-in only. The service refuses startup until protected
  // native descriptor/dispatch qualification can be composed at this boundary.
  readonly oauthEnrollment?: OAuthEnrollmentConfig;
}
export interface OAuthEnrollmentConfig {
  readonly enabled: true;
  readonly profile: 'openai-codex-oauth-responses-v1';
  readonly modelScope: readonly ['gpt-6.1-sol'];
}
const deny = (): never => { throw new ServiceError('config_denied'); };
function text(v: unknown): string { if (typeof v !== 'string') return deny(); return v; }
function path(v: unknown): string {
  const p = text(v); if (!isAbsolute(p) || normalize(p) !== p || p.includes('\0')) return deny(); return p;
}
// Protected ancestors prevent replacement between validation and native exec.
function protectedPath(p: string, kind: 'file' | 'directory' | 'executable'): void {
  for (let a = dirname(p);; a = dirname(a)) {
    const s = lstatSync(a);
    if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o022)) deny();
    if (a === '/') break;
  }
  const s = lstatSync(p);
  if (s.uid !== 0 || (s.mode & 0o022)) deny();
  if (kind === 'directory') { if (!s.isDirectory() || (s.mode & 0o777) !== 0o700) deny(); }
  else if (!s.isFile() || s.nlink !== 1 || (kind === 'file' ? (s.mode & 0o777) !== 0o600 : !(s.mode & 0o100))) deny();
}
export function keyBytes(s: string): Buffer {
  const b = Buffer.from(s, 'base64');
  if (b.length !== 32 || b.toString('base64') !== s) return deny(); return b;
}
function origin(v: unknown): string {
  const s = text(v), u = new URL(s);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port ||
      u.origin !== s || Number(u.port) < 1024 || u.username || u.password) return deny();
  return s;
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v;
}
// No caller/provider endpoint override or inferred alias; API-key profile stays
// the service default. Catalog evidence alone cannot enable a native account.
export function captureOAuthEnrollmentConfig(value: unknown): OAuthEnrollmentConfig {
  try {
    const r = object(value, ['enabled','profile','modelScope']);
    if (r.enabled !== true || r.profile !== codexOAuthProfile.profile || !Array.isArray(r.modelScope) ||
        r.modelScope.length !== 1 || r.modelScope[0] !== codexOAuthProfile.model) return deny();
    return Object.freeze({ enabled: true, profile: 'openai-codex-oauth-responses-v1',
      modelScope: Object.freeze(['gpt-6.1-sol'] as const) });
  } catch { return deny(); }
}
// Sole entry: synchronous capture/validation before the first startup await.
// No provider credential or native custody bytes are read here.
export function loadServiceConfig(file: string): ServiceConfig {
  try {
    if (process.geteuid?.() !== 0) return deny();
    protectedPath(path(file), 'file');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 65_536) return deny();
      bytes = Buffer.alloc(65_537);
      // readFileSync would permit growth after fstat; bounded positional read below.
      bytes = readBounded(fd, bytes);
    } finally { closeSync(fd); }
    const r = object(strictJSON(bytes), ['kernelDSN','durableFacts','facadeOrigin','callbackOrigin','native','consumer','profile','bearers','keys'], ['oauthEnrollment']);
    const oauthEnrollment = Object.hasOwn(r, 'oauthEnrollment') ? captureOAuthEnrollmentConfig(r.oauthEnrollment) : undefined;
    // Use the kernel's existing bound authority after exact protected parsing.
    // Missing, extra, nonnumeric or inconsistent values deny before startup IO.
    const durableFacts = boundedFacts(object(r.durableFacts,
      ['maxServiceFacts','maxConsumerFacts','maxAccountFacts','workerSlots','issuerSlots']) as unknown as DurableFactBounds);
    const n = object(r.native, ['executable','sha256','bootstrapFile','authorityDir','origin','originRef','uid','gid']);
    const c = object(r.consumer, ['consumerId','managementCredential','executionCredential','cleanupCredential','callbackCredential']);
    const p = object(r.profile, ['profile','model','baseURL','qualificationRef','limits','providerTokenUpperBound']);
    const k = object(r.keys, ['intentAEAD','intentHMAC','facadeHMAC']);
    const native = { executable: path(n.executable), sha256: text(n.sha256), bootstrapFile: path(n.bootstrapFile),
      authorityDir: path(n.authorityDir), origin: origin(n.origin), originRef: text(n.originRef), uid: n.uid as number, gid: n.gid as number };
    integer(native.uid, 4_294_967_294); integer(native.gid, 4_294_967_294); identifier(native.originRef);
    protectedPath(native.executable, 'executable'); protectedPath(native.bootstrapFile, 'file'); protectedPath(native.authorityDir, 'directory');
    if (!/^[a-f0-9]{64}$/.test(native.sha256) || imageHash(native.executable) !== native.sha256) deny();
    const consumer = { consumerId: text(c.consumerId), managementCredential: text(c.managementCredential),
      executionCredential: text(c.executionCredential), cleanupCredential: text(c.cleanupCredential), callbackCredential: text(c.callbackCredential) };
    const profile = { profile: text(p.profile), model: text(p.model), baseURL: text(p.baseURL), qualificationRef: text(p.qualificationRef),
      limits: approvedLimits(p.limits as ApprovedLimits, defaults), providerTokenUpperBound: p.providerTokenUpperBound as number };
    if (profile.profile !== 'openai-responses-apikey-v1') deny();
    identifier(consumer.consumerId); identifier(profile.qualificationRef);
    physicalCandidate({ ...profile, generation: '00000000-0000-4000-8000-000000000001',
      nativePhysicalIdentity: '00000000-0000-4000-8000-000000000001', nativeId: 1, createdAt: '2000-01-01T00:00:00Z' });
    integer(profile.providerTokenUpperBound, 10_000_000);
    if (profile.limits.tokens > profile.providerTokenUpperBound) deny();
    const keys = { intentAEAD: text(k.intentAEAD), intentHMAC: text(k.intentHMAC), facadeHMAC: text(k.facadeHMAC) };
    Object.values(keys).forEach(keyBytes);
    if (new Set(Object.values(keys)).size !== 3) deny();
    if (!Array.isArray(r.bearers) || !r.bearers.length) deny();
    const bearers = r.bearers as (ManagementBearer | RunControlBearer)[];
    for (const b of bearers) {
      if (b.consumerId !== consumer.consumerId || !['management','run-control'].includes(b.role)) deny();
      if (b.role === 'management') {
        object(b, ['token','role','consumerId','ownerRefs','preparation']);
        object(b.preparation, ['accountRefs','subjectRef','policyRevision','bindingRevision','profileId','limits','maxRunMs']);
        if (b.preparation.profileId !== profile.profile) deny();
      } else {
        object(b, ['token','role','consumerId','ownerRefs','profileIds','limits','maxRunMs']);
        if (b.profileIds.some(id => id !== profile.profile)) deny();
      }
      const grant = b.role === 'management' ? b.preparation : b;
      approvedLimits(grant.limits, { ...defaults, maxRequests: profile.limits.requests, maxConcurrent: profile.limits.concurrency,
        maxRequestBytes: profile.limits.requestBytes, maxOutputBytes: profile.limits.outputBytes, maxTokens: profile.limits.tokens });
      integer(grant.maxRunMs, defaults.maxRunMs);
    }
    new FacadeBearers(bearers);
    const credentials = [consumer.managementCredential, consumer.executionCredential, consumer.cleanupCredential, consumer.callbackCredential, ...bearers.map(b => b.token)];
    if (credentials.some(t => !/^[A-Za-z0-9._~-]{16,1024}$/.test(t)) || new Set(credentials).size !== credentials.length) deny();
    const kernelDSN = text(r.kernelDSN), u = new URL(kernelDSN);
    if (!['postgres:','postgresql:'].includes(u.protocol) || u.pathname.length < 2) deny();
    const facadeOrigin = origin(r.facadeOrigin), callbackOrigin = origin(r.callbackOrigin);
    if (new Set([facadeOrigin, callbackOrigin, native.origin]).size !== 3) deny();
    return freeze({ kernelDSN, durableFacts, facadeOrigin, callbackOrigin, native, consumer, profile, bearers, keys,
      ...(oauthEnrollment === undefined ? {} : { oauthEnrollment }) });
  } catch { return deny(); }
}
function readBounded(fd: number, b: Buffer): Buffer {
  let size = 0, count: number;
  do { count = readSync(fd, b, size, b.length - size, size); size += count; } while (count && size < b.length);
  if (size > 65_536) return deny(); return b.subarray(0, size);
}
function imageHash(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o022) || !(s.mode & 0o100) || s.size > 134_217_728) return deny();
    const hash = createHash('sha256'), b = Buffer.alloc(65_536); let size = 0, n: number;
    while ((n = readSync(fd, b, 0, b.length, size)) > 0) {
      size += n; if (size > 134_217_728) return deny(); hash.update(b.subarray(0, n));
    }
    if (size !== s.size) return deny(); return hash.digest('hex');
  } finally { closeSync(fd); }
}
