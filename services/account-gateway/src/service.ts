import { PostgresUsageJournal } from './usage.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import pg from 'pg';
import { ServiceAdmission, facadeControlRoute, facadeUsageReadRoute, inServiceLane } from './service-admission.ts';
import { KernelError, defaults, uuid } from './domain.ts';
import type { Bounds } from './domain.ts';
import { PostgresKernel } from './postgres.ts';
import { IntentSecrets, PostgresManagementStore } from './management-store.ts';
import { AccountManagement, exactCandidate, sameCandidate } from './management.ts';
import type { CandidateJournal, CandidateNative, IntentCustody, ManagementStore, OAuthScope, OAuthCallback,
  OAuthCleanupAuthority, OAuthCleanupAction, OAuthMethod } from './management.ts';
import type { DurableKernel, ExecutionRead, TrustedContext } from './domain.ts';
import { codexOAuthProfile } from './management.ts';
import { NativeAccountLimitsClient, NativeManagementClient, NativeRetainedCustodyClient, NativeOAuthEnrollmentClient, NativeOAuthLifecycleClient } from './native-client.ts';
import { NativeAuthority } from './native-authority.ts';
import { NativeHTTPTransport } from './native-transport.ts';
import { createFacade, FacadeBearers, cancelFacadeTransport } from './facade.ts';
import type { ConfiguredBearer, FacadeOptions } from './facade.ts';
import { strictJSON } from './facade-ingress.ts';
import { object } from './native-wire.ts';
import { nativeResponseDiagnostics } from './native-response-diagnostics.ts';
import { captureServiceBearers, captureServiceProfiles, loadServiceConfig, keyBytes, ServiceError } from './service-config.ts';
import type { ServiceConfig } from './service-config.ts';

type RunDurationBearer = Extract<ConfiguredBearer, { readonly role: 'consumer-control' | 'run-control' }>;
function isRunDurationBearer(bearer: ConfiguredBearer): bearer is RunDurationBearer {
  return bearer.role === 'consumer-control' || bearer.role === 'run-control';
}
export function composeKernelBounds(bearers: readonly ConfiguredBearer[]): Bounds {
  const runDurationBearers = bearers.filter(isRunDurationBearer);
  const maxRunMs = runDurationBearers.reduce((max, bearer) => Math.max(max, bearer.maxRunMs), defaults.maxRunMs);
  return Object.freeze({ ...defaults, maxRunMs });
}

// Cleanup gets the first turn. An acquired claim yields the next serial tick
// to OAuth maintenance so a retained, uncloseable generation cannot starve it.
export function composeServiceCleanupClaim(kernel: Pick<DurableKernel, 'claimCleanup'>, ctx: TrustedContext, worker: string) {
  let refreshTurn = false;
  return async () => {
    if (refreshTurn) { refreshTurn = false; return undefined; }
    const claim = await kernel.claimCleanup(ctx, worker);
    refreshTurn = claim !== undefined;
    return claim;
  };
}

// Trusted composition only: AccountManagement reconstructs OAuthScope from its
// committed original journal. Each call binds a fresh fixed-owner client; no
// owner cache, caller factory, callback URL or bearer transfer is introduced.
export function composeServiceControl(cfg: Pick<ServiceConfig, 'native' | 'consumer' | 'profile' | 'secondProfile' | 'oauthEnrollment' | 'bearers'>,
  kernel: DurableKernel & ExecutionRead, store: ManagementStore, custody: IntentCustody, worker: string) {
  const profiles = captureServiceProfiles(cfg);
  const consumerId = cfg.consumer.consumerId;
  const bearers = new FacadeBearers(captureServiceBearers(cfg.bearers, consumerId, profiles));
  const control = { origin: cfg.native.origin, consumerId,
    controlCredential: cfg.consumer.managementCredential };
  const client = new NativeManagementClient(control);
  const checkProfile = (j: CandidateJournal) => {
    const p = profiles.find(p => p.profile === j.profile.profile);
    if (!p || p.profile === codexOAuthProfile.profile || j.consumerId !== consumerId || j.profile.model !== p.model ||
        j.profile.baseURL !== p.baseURL || j.profile.qualificationRef !== p.qualificationRef) throw new KernelError('denied');
  };
  const native: CandidateNative = {
    create(j, name, key) { checkProfile(j); return client.create(j, name, key); },
    read(j) { checkProfile(j); return client.read(j); },
    setState(j, state) { checkProfile(j); return client.setState(j, state); },
    erase(j) { checkProfile(j); return client.erase(j); },
  };
  const oauthProfile = profiles.find(p => p.profile === codexOAuthProfile.profile);
  const forScope = (scope: OAuthScope) => new NativeOAuthEnrollmentClient({ ...control, ownerRef: scope.ownerRef });
  const management = new AccountManagement({ kernel, store, custody, native, worker,
    profiles: profiles.filter(p => p.profile !== codexOAuthProfile.profile),
    retainedCustody: new NativeRetainedCustodyClient(control),
    ...(oauthProfile ? { oauth: { profile: oauthProfile, native: {
      begin: (scope: OAuthScope, method?: OAuthMethod) => forScope(scope).begin(scope, method),
      read: (scope: OAuthScope) => forScope(scope).read(scope),
      poll: (scope: OAuthScope) => forScope(scope).poll(scope),
      complete: (scope: OAuthScope, callback: OAuthCallback) => forScope(scope).complete(scope, callback),
    }, descriptor: { describe: (scope: OAuthScope) => forScope(scope).describe(scope) },
      lifecycle: { cleanup: (scope: OAuthScope, authority: OAuthCleanupAuthority, action: OAuthCleanupAction) => new NativeOAuthLifecycleClient({ ...control,
        controlCredential: cfg.consumer.cleanupCredential, ownerRef: scope.ownerRef }).cleanup(scope, authority, action) } },
      refresh: { refresh: (scope: OAuthScope) => forScope(scope).refresh(scope) } } : {}),
    proof: { async verify(j, d) {
      const p = profiles.find(p => p.profile === j.profile.profile);
      const rows = await native.read(j);
      return !!p && rows.length === 1 && rows[0].state === 'inactive' && exactCandidate(j, d) &&
        exactCandidate(j, rows[0]) && sameCandidate(d, rows[0]) && j.profile.model === p.model &&
        j.profile.baseURL === p.baseURL && j.profile.qualificationRef === p.qualificationRef;
    } } });
  const catalog: FacadeOptions['profiles'] = Object.freeze(profiles.map(p => ({
    dto: { profileId: p.profile, protocol: 'openai-responses' as const, modelIds: [p.model],
      authKinds: [p.profile === codexOAuthProfile.profile ? 'oauth' as const : 'api_key' as const] },
    maxOutputTokens: p.limits.tokens, limits: p.limits,
  })));
  return Object.freeze({ profiles, bearers, management, catalog, accountLimits: new NativeAccountLimitsClient(control) });
}
export function composeServiceNative(cfg: Pick<ServiceConfig, 'native' | 'consumer' | 'oauthEnrollment'>,
  control: ReturnType<typeof composeServiceControl>, kernel: DurableKernel & ExecutionRead, store: ManagementStore,
  enrollment: NonNullable<FacadeOptions['enrollment']>) {
  const authority = new NativeAuthority({ kernel, store, accountLimitsOwners: { bearers: control.bearers }, ...(cfg.oauthEnrollment ? {
    oauthOwners: { store, bearers: control.bearers }, oauthRefreshOwners: { store, bearers: control.bearers },
    oauthCleanupOwners: { store } } : {}),
    profileLimits: control.profiles.map(p => ({ profile: p.profile, limits: p.limits })), config: { origin: cfg.native.origin,
      enrollment: { ...enrollment, qualificationRef: control.profiles[0].qualificationRef }, consumers: [cfg.consumer],
      profiles: control.profiles.map(p => ({ ...p, requestBytes: p.limits.requestBytes, outputBytes: p.limits.outputBytes,
        tokens: p.limits.tokens })), timeoutMs: 5000, closureWaitMs: 1000, maxPending: 128 } });
  return Object.freeze({ authority, transport: new NativeHTTPTransport(authority) });
}

export interface ProcessBinding {
  readonly originRef: string; readonly bootId: string; readonly incarnation: string;
  readonly pid: string; readonly birthTicks: string; readonly lockDevice: string; readonly lockInode: string;
}
export interface Retirement {
  readonly binding: ProcessBinding; readonly scope: string; readonly method: string;
}
export interface Service {
  readonly binding: ProcessBinding;
  readonly stopped: Promise<'retired' | 'pending'>;
  stop(): Promise<'retired' | 'pending'>;
}
function captured(value: unknown, originRef: string): ProcessBinding {
  const r = object(value, ['originRef','bootId','incarnation','pid','birthTicks','lockDevice','lockInode']);
  if (r.originRef !== originRef) throw new ServiceError('runtime_denied');
  uuid(r.bootId); uuid(r.incarnation);
  for (const k of ['pid','birthTicks','lockDevice','lockInode']) {
    const v = r[k];
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > 18_446_744_073_709_551_615n)
      throw new ServiceError('runtime_denied');
  }
  if (BigInt(r.pid as string) > 2_147_483_647n) throw new ServiceError('runtime_denied');
  return Object.freeze({ ...r }) as unknown as ProcessBinding;
}
const same = (a: ProcessBinding, b: ProcessBinding) =>
  Object.keys(a).every(k => a[k as keyof ProcessBinding] === b[k as keyof ProcessBinding]);

// Private root composition. Selectors only filter the protected native journal;
// its complete stored old binding, not a PID supplied by SQL, proves teardown.
export function composeServiceRetirementReadback(native: Pick<ServiceConfig['native'], 'executable' | 'authorityDir' | 'originRef'>) {
  const { executable, authorityDir, originRef } = native;
  let active: ReturnType<typeof spawn> | true | undefined;
  return async (current: ProcessBinding, selector: Readonly<{ originRef: string; engineIncarnation: string }>,
    signal: AbortSignal): Promise<Retirement | undefined> => {
    let input: Buffer;
    const selected = { originRef: selector.originRef, engineIncarnation: selector.engineIncarnation };
    try {
      current = captured(current, originRef); uuid(selected.engineIncarnation);
      if (active || signal.aborted || selected.originRef !== originRef || selected.engineIncarnation === current.incarnation) return;
      input = Buffer.from(JSON.stringify({ current, selectors: [selected] }));
      if (input.length > 4096) return;
    } catch { return; }
    return new Promise(resolve => {
      const deadline = Date.now() + 5000;
      let query: ReturnType<typeof spawn>;
      active = true; // Reserve custody before the synchronous spawn boundary.
      try {
        query = spawn(executable, ['--read-retirement', '--authority-dir', authorityDir, '--origin-ref', originRef],
          { env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'], shell: false, detached: false });
        active = query;
      } catch { active = undefined; resolve(undefined); return; }
      let failed = false, done = false, eof = false, sent = false, bytes = 0, diagnostics = 0;
      const chunks: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout>;
      const finish = (receipt?: Retirement) => {
        if (done) return;
        done = true; clearTimeout(timer); signal.removeEventListener('abort', terminate);
        resolve(receipt);
      };
      const terminate = () => {
        if (done || failed) return;
        failed = true; chunks.length = 0; clearTimeout(timer);
        // This readonly subprocess is the only signal target. Reserve disposal
        // time within the five-second call budget; late output cannot be reused.
        try { query.kill('SIGKILL'); } catch { /* finite denial only */ }
        query.stdin?.destroy(); query.stdout?.destroy(); query.stderr?.destroy();
        timer = setTimeout(() => finish(), Math.max(1, Math.min(500, deadline - Date.now())));
      };
      timer = setTimeout(terminate, Math.max(1, deadline - Date.now() - 500));
      query.once('error', terminate);
      query.stdin!.on('error', terminate);
      query.stdout!.on('error', terminate);
      query.stderr!.on('error', terminate);
      query.stdin!.once('finish', () => { sent = true; });
      query.stdout!.once('end', () => { eof = true; });
      query.stdout!.on('data', (b: Buffer) => {
        if (failed || done) return;
        bytes += b.length;
        if (bytes > 4096) terminate(); else chunks.push(b);
      });
      query.stderr!.on('data', (b: Buffer) => {
        diagnostics += b.length; if (diagnostics > 4096) terminate();
      });
      query.once('close', (code, exitSignal) => {
        // Logical timeout cannot release physical custody. Only this exact
        // handle's close permits another query, even after finish() resolved.
        if (active === query) active = undefined;
        if (done) return;
        if (failed || signal.aborted || Date.now() >= deadline || !sent || !eof || code !== 0 || exitSignal !== null) { finish(); return; }
        try {
          const reply = object(strictJSON(Buffer.concat(chunks)), ['receipts']);
          if (!Array.isArray(reply.receipts) || reply.receipts.length !== 1) throw new ServiceError('runtime_denied');
          const r = object(reply.receipts[0], ['binding','scope','method']), old = captured(r.binding, originRef);
          if (old.incarnation !== selected.engineIncarnation || old.incarnation === current.incarnation ||
              old.bootId !== current.bootId || old.lockDevice !== current.lockDevice || old.lockInode !== current.lockInode ||
              r.scope !== 'exact-local-process-transport-teardown-v1' ||
              !['observed-child-exit','reacquired-after-supervisor-loss'].includes(r.method as string)) throw new ServiceError('runtime_denied');
          finish(Object.freeze({ binding: old, scope: r.scope, method: r.method as string }));
        } catch { finish(); }
      });
      signal.addEventListener('abort', terminate, { once: true });
      if (signal.aborted) terminate(); else query.stdin!.end(input);
    });
  };
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServiceError('runtime_denied')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function listen(s: Server, origin: string): Promise<void> {
  const u = new URL(origin);
  await bounded(new Promise<void>((resolve, reject) => {
    s.once('error', reject); s.listen(Number(u.port), '127.0.0.1', () => { s.removeListener('error', reject); resolve(); });
  }), 5000);
}
async function close(s: Server | undefined): Promise<void> {
  if (!s) return;
  const closed = new Promise<void>(resolve => s.close(() => resolve()));
  s.closeAllConnections(); await bounded(closed, 1000).catch(() => undefined);
}

// Each call is one foreground deployable unit, one configured consumer and one
// original protected Go parent. No recovery spawn, inference replay or PID lookup.
type RuntimeFailureCause = 'pool_error' | 'callback_error' | 'child_error' | 'child_exit' | 'diagnostic_limit' | 'child_pending' | 'metadata_invalid' | 'stdout_incomplete' | 'stdout_error' | 'stderr_error' | 'facade_error' | 'control_error' | 'maintenance_failed' | 'runtime_invalidated';
type MaintenancePhase = 'heartbeat' | 'reconcile' | 'cleanup_claim' | 'cleanup_generation' | 'cleanup_transport' | 'cleanup_settlement' | 'oauth_refresh';
export function runtimeFailureDiagnostic(cause: RuntimeFailureCause, error?: unknown, maintenancePhase?: MaintenancePhase) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const phase = cause === 'maintenance_failed' && ['heartbeat','reconcile','cleanup_claim','cleanup_generation','cleanup_transport','cleanup_settlement','oauth_refresh'].includes(maintenancePhase ?? '') ? maintenancePhase : undefined;
  return { event: 'gateway_service_runtime_failure', cause, ...(phase ? { maintenancePhase: phase } : {}),
    code: error instanceof KernelError && typeof code === 'string' && ['invalid','unknown','conflict','denied','unavailable'].includes(code) ? `kernel_${code}` : typeof code === 'string' && ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','57014','runtime_denied','quota_denied'].includes(code) ? code : 'UNKNOWN' };
}

export function writeRuntimeFailureDiagnostic(cause: RuntimeFailureCause, error?: unknown, maintenancePhase?: MaintenancePhase): void {
  try { writeSync(2, JSON.stringify(runtimeFailureDiagnostic(cause, error, maintenancePhase)) + '\n'); } catch { /* Diagnostics never prevent closure. */ }
}

export async function startService(configFile: string, signal?: AbortSignal): Promise<Service> {
  const admission = new ServiceAdmission();
  const cfg = loadServiceConfig(configFile); // Fully frozen before any await.
  const pool = new pg.Pool({ connectionString: cfg.kernelDSN, max: 8, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
  pool.on('error', error => fail(error, 'pool_error'));
  const kernel = new PostgresKernel(pool, composeKernelBounds(cfg.bearers), cfg.durableFacts),
    worker = randomUUID(), ctx = Object.freeze({ consumerId: cfg.consumer.consumerId });
  const custody = new IntentSecrets(keyBytes(cfg.keys.intentAEAD), keyBytes(cfg.keys.intentHMAC));
  const store = new PostgresManagementStore(pool, custody);
  const control = composeServiceControl(cfg, kernel, store, custody, worker);
  const { profiles, bearers, management, catalog } = control;
  const readRetirement = composeServiceRetirementReadback(cfg.native), readbackAbort = new AbortController();
  let handler: Server | undefined, facade: Server | undefined, controlFacade: Server | undefined;
  let original: ProcessBinding | undefined, ready = false, invalid = false, stopping = false;
  let terminal: 'retired' | 'pending' | undefined, retirement: Retirement | undefined;
  let child: ReturnType<typeof spawn> | undefined, options: FacadeOptions | undefined;
  type StartupStage = 'starting' | 'ready' | 'heartbeat' | 'facade-listen';
  let startupStage: StartupStage | undefined = 'starting';
  let startupFailure: { cause: unknown; stage: StartupStage } | undefined;
  function retainStartupFailure(cause: unknown) {
    if (startupStage !== undefined && !startupFailure) startupFailure = { cause, stage: startupStage };
  }
  let notify: (() => void) | undefined;
  const pulse = () => { notify?.(); notify = undefined; };
  function startupActive() {
    if (stopping || invalid || exited || signal?.aborted) throw new ServiceError('startup_denied');
  }
  const waitFor = async (predicate: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      startupActive();
      await bounded(new Promise<void>(resolve => { notify = resolve; }), Math.max(1, deadline - Date.now()));
    }
  };
  let exited = false, exitCode: number | null = null;
  let exitResolve!: () => void;
  const exit = new Promise<void>(resolve => { exitResolve = resolve; });
  let install!: () => void;
  const installed = new Promise<void>(resolve => { install = resolve; });
  let finish!: (result: 'retired' | 'pending') => void;
  const stopped = new Promise<'retired' | 'pending'>(resolve => { finish = resolve; });
  let stopWork: Promise<'retired' | 'pending'> | undefined;
  let maintenance: Promise<void> = Promise.resolve();
  let maintenancePhase: MaintenancePhase = 'heartbeat';
  let inFlightTick: Promise<void> = Promise.resolve(), enrollmentWaiters = 0;
  let wakeSleep: (() => void) | undefined;
  function denyAdmission() { bearers.replace([]); facade?.closeAllConnections(); }
  function fail(error?: unknown, cause: RuntimeFailureCause = 'runtime_invalidated') {
    const report = !stopping && startupStage === undefined;
    if (!stopping && error !== undefined) retainStartupFailure(error);
    invalid = true; denyAdmission(); pulse(); void stop();
    if (report) writeRuntimeFailureDiagnostic(cause, error, cause === 'maintenance_failed' ? maintenancePhase : undefined);
  }
  let usageCallbacks = 0;
  const callback = createServer({ maxHeaderSize: 16_384, headersTimeout: 5000, requestTimeout: 5000,
    keepAliveTimeout: 1000, connectionsCheckingInterval: 100 }, (req, res) => {
    const timer = setTimeout(() => { res.destroy(); req.destroy(); }, 5000);
    res.once('close', () => clearTimeout(timer));
    if (facadeControlRoute(req.method, req.url)) {
      if (!controlFacade || stopping || invalid) { res.writeHead(503); res.end(); return; }
      // Analytics shares this protected listener with native proof/cleanup.
      // Keep two of its eight sockets available for the control protocol.
      if (facadeUsageReadRoute(req.method, req.url)) {
        if (usageCallbacks >= 6) { res.writeHead(503, { connection: 'close' }); res.end(); return; }
        usageCallbacks++; req.socket.once('close', () => { usageCallbacks--; });
      }
      controlFacade.emit('request', req, res); return;
    }
    if (req.method !== 'POST' || !/^\/private\/native\/v1\/(enrollment|admit|dispatch-proof|cleanup-authority|owner-closure-authority|closure-ack|oauth-owner-authority|oauth-custody-authority|oauth-refresh-authority|oauth-cleanup-authority|account-limits-authority)$/.test(req.url ?? '')) {
      res.writeHead(403); res.end(); return;
    }
    // Go's first enrollment can arrive before stdout's actual starting binding.
    // Hold only this bounded listener; never ACK a synthetic authority.
    const dispatch = () => {
      if (res.destroyed || res.writableEnded) return;
      if (!handler || stopping || invalid) { res.writeHead(503); res.end(); return; }
      handler.emit('request', req, res);
    };
    if (handler) { dispatch(); return; }
    // Timed-out pre-binding requests remain attached to the enrollment promise
    // until installation. Cap those retained requests as well as live sockets.
    if (enrollmentWaiters >= 8) { res.writeHead(503); res.end(); req.destroy(); return; }
    enrollmentWaiters++;
    void installed.then(dispatch).catch(() => { res.destroy(); }).finally(() => { enrollmentWaiters--; });
  });
  callback.maxConnections = 8; callback.maxRequestsPerSocket = 1;
  callback.on('clientError', (_e, socket) => socket.destroy());
  callback.on('error', error => fail(error, 'callback_error'));
  function stop(): Promise<'retired' | 'pending'> {
    if (stopWork) return stopWork;
    if (stopping) return stopped;
    stopping = true; const handlersSettled = admission.stop(); readbackAbort.abort(); denyAdmission(); install(); pulse(); wakeSleep?.();
    // Signal only the original ChildProcess handle. The protected Go parent
    // alone decides exact-engine retirement and retains launcher disk evidence.
    if (child && !exited) {
      try { if (!child.kill('SIGTERM')) invalid = true; } catch { invalid = true; }
    }
    stopWork = (async () => {
      await Promise.all([close(facade), close(callback), close(handler), close(controlFacade)]);
      await bounded(Promise.all([maintenance, inFlightTick, handlersSettled]), 6500).catch(() => { invalid = true; });
      if (child) await bounded(exit, 12_000).catch(() => { invalid = true; });
      await bounded(pool.end(), 6000).catch(() => { invalid = true; });
      signal?.removeEventListener('abort', onAbort);
      const result = original && retirement && terminal === 'retired' && exitCode === 0 && !invalid ? 'retired' : 'pending';
      finish(result); return result;
    })();
    return stopWork;
  }
  const onAbort = () => { void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    startupActive();
    // Migrations are an operator prerequisite. Startup merely verifies access.
    await pool.query('SELECT 1 FROM ag_kernel.accounts LIMIT 0');
    startupActive();
    await pool.query('SELECT native_created_at FROM ag_management.physical_mappings LIMIT 0');
    startupActive();
    await pool.query('SELECT transport_occupied,closure_token,native_origin_ref,engine_incarnation,request_nonce,descriptor_generation FROM ag_kernel.requests LIMIT 0');
    startupActive();
    await listen(callback, cfg.callbackOrigin);
    startupActive();
    child = spawn(cfg.native.executable, ['--bootstrap-file', cfg.native.bootstrapFile, '--authority-dir', cfg.native.authorityDir,
      '--origin-ref', cfg.native.originRef, '--engine-uid', String(cfg.native.uid), '--engine-gid', String(cfg.native.gid)],
    { env: {}, stdio: ['ignore','pipe','pipe'], detached: false });
    child.once('error', error => { exited = true; exitResolve(); fail(error, 'child_error'); });
    child.once('exit', () => { exited = true; denyAdmission(); pulse(); if (!stopping) fail(undefined, 'child_exit'); });
    child.once('close', code => {
      exitCode = code; exited = true; exitResolve(); denyAdmission(); pulse();
      if (!stopping) { invalid = true; void stop(); }
    });
    let diagnostics = 0, metadata = 0, buffer = Buffer.alloc(0), sequence = 0;
    const forwardDiagnostics = nativeResponseDiagnostics(record => { process.stderr.write(record); });
    child.stderr!.on('data', (b: Buffer) => {
      diagnostics += b.length;
      if (diagnostics > 65_536) { fail(undefined, 'diagnostic_limit'); return; }
      forwardDiagnostics(b);
    });
    child.stdout!.on('data', (b: Buffer) => {
      try {
        metadata += b.length; if (metadata > 16_384) throw new ServiceError('runtime_denied');
        buffer = Buffer.concat([buffer, b]);
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          if (newline > 4096) throw new ServiceError('runtime_denied');
          const r = object(strictJSON(buffer.subarray(0, newline)), ['state','binding'], ['receipt','authorityDir']);
          buffer = buffer.subarray(newline + 1);
          const actual = captured(r.binding, cfg.native.originRef);
          if (original && !same(actual, original)) throw new ServiceError('runtime_denied');
          if (r.state === 'starting' && sequence === 0 && !stopping && r.receipt === undefined && r.authorityDir === undefined) {
            original = actual; sequence = 1;
          } else if (r.state === 'ready' && sequence === 1 && !stopping && r.receipt === undefined && r.authorityDir === undefined) {
            ready = true; sequence = 2;
          } else if (r.state === 'retired' && original && sequence >= 1 && !terminal && r.authorityDir === undefined) {
            const receipt = object(r.receipt, ['binding','scope','method']);
            if (!same(captured(receipt.binding, cfg.native.originRef), original) ||
                receipt.scope !== 'exact-local-process-transport-teardown-v1' ||
                receipt.method !== 'observed-child-exit') throw new ServiceError('runtime_denied');
            retirement = Object.freeze({ binding: original, scope: receipt.scope, method: receipt.method }); terminal = 'retired';
            denyAdmission(); if (!stopping) { invalid = true; void stop(); }
          } else if (r.state === 'pending' && !terminal && r.authorityDir === cfg.native.authorityDir && r.receipt === undefined) {
            terminal = 'pending'; fail(undefined, 'child_pending');
          } else throw new ServiceError('runtime_denied');
          pulse();
        }
        if (buffer.length > 4096) throw new ServiceError('runtime_denied');
      } catch (error) { fail(error, 'metadata_invalid'); }
    });
    child.stdout!.once('end', () => { if (buffer.length || !terminal) fail(undefined, 'stdout_incomplete'); });
    child.stdout!.on('error', error => fail(error, 'stdout_error')); child.stderr!.on('error', error => fail(error, 'stderr_error'));
    await waitFor(() => original !== undefined, 10_000);
    startupActive();
    const binding = original!;
    const enrollment = Object.freeze({ originRef: binding.originRef, engineIncarnation: binding.incarnation, worker });
    const { authority, transport } = composeServiceNative(cfg, control, kernel, store, enrollment);
    handler = authority.createServer((_req, res, work) => {
      const release = admission.reserve('control');
      if (!release) { res.writeHead(503); res.end(); return; }
      void inServiceLane('control', work).finally(release).catch(() => { res.destroy(); });
    }); install();
    startupStage = 'ready';
    await waitFor(() => ready, 10_000);
    startupActive();
    startupStage = 'heartbeat';
    await inServiceLane('control', () => kernel.heartbeat(ctx, worker));
    startupActive();
    options = { admission, kernel, management, store, bearers, enrollment, transport, accountLimits: control.accountLimits,
      usage: new PostgresUsageJournal(pool, keyBytes(cfg.keys.facadeHMAC)),
      profiles: catalog, intentHmacKey: keyBytes(cfg.keys.facadeHMAC), ingressBytes: Math.max(1024, ...profiles.map(p => p.limits.requestBytes)),
      bufferBytes: 65_536, ...(cfg.accountLifecycle ? { lifecycle: cfg.accountLifecycle } : {}) };
    startupStage = 'facade-listen';
    facade = createFacade(options); facade.on('error', error => fail(error, 'facade_error'));
    controlFacade = createFacade({ ...options, controlOnly: true }); controlFacade.on('error', error => fail(error, 'control_error'));
    await listen(facade, cfg.facadeOrigin);
    startupActive();
    const claimCleanup = composeServiceCleanupClaim(kernel, ctx, worker);
    async function tick(): Promise<void> {
        maintenancePhase = 'heartbeat';
        await kernel.heartbeat(ctx, worker);
        if (stopping) return;
        maintenancePhase = 'reconcile';
        await management.reconcile(ctx);
        if (stopping) return;
        maintenancePhase = 'cleanup_claim';
        const claim = await claimCleanup();
        if (stopping) return; // An acquired lease remains outstanding until expiry.
        if (claim?.scope.kind === 'generation') {
          maintenancePhase = 'cleanup_generation';
          await management.cleanupClaim(ctx, claim);
        }
        else if (claim) {
          maintenancePhase = 'cleanup_transport';
          let closed = true;
          if (claim.scope.transports.length > 2) closed = false;
          for (const t of claim.scope.transports.slice(0, 2)) {
            if (stopping) { closed = false; break; }
            if (!t.native || !t.token || t.native.originRef !== binding.originRef) { closed = false; continue; }
            try {
              if (t.native.engineIncarnation === binding.incarnation)
                await cancelFacadeTransport(options!, ctx, { ...t, native: t.native, token: t.token }, claim);
              else {
                const receipt = await readRetirement(binding, t.native, readbackAbort.signal);
                if (!receipt || stopping) { closed = false; continue; }
                await kernel.acknowledgeTransportClosed(ctx, worker, t, { cleanupRef: claim.cleanupRef, token: claim.token });
              }
            }
            catch { closed = false; }
          }
          if (stopping) return;
          maintenancePhase = 'cleanup_settlement';
          await kernel.settleCleanup(ctx, claim.cleanupRef, worker, claim.token, closed);
        }
        if (stopping) return;
        maintenancePhase = 'oauth_refresh';
        await management.refreshOAuth(ctx, claim !== undefined, readbackAbort.signal);
    }
    maintenance = (async () => {
      while (!stopping) {
        inFlightTick = inServiceLane('control', tick);
        await bounded(inFlightTick, 15_000);
        if (!stopping) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wakeSleep = undefined; resolve(); }, 1000);
          wakeSleep = () => { clearTimeout(timer); wakeSleep = undefined; resolve(); };
        });
      }
    })().catch(error => fail(error, 'maintenance_failed'));
    startupStage = undefined;
    return Object.freeze({ binding, stopped, stop });
  } catch (error) {
    retainStartupFailure(error);
    const denied = new ServiceError('startup_denied');
    Object.defineProperties(denied, {
      cause: { value: startupFailure!.cause, enumerable: false },
      startupStage: { value: startupFailure!.stage, enumerable: false },
    });
    try {
      await stop();
      // A listen already in flight at cancellation can finish after stop's snapshot.
      await Promise.all([close(facade), close(callback), close(handler), close(controlFacade)]);
    } finally { throw denied; }
  }
}
