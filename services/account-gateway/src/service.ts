import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import pg from 'pg';
import { uuid } from './domain.ts';
import { PostgresKernel } from './postgres.ts';
import { IntentSecrets, PostgresManagementStore } from './management-store.ts';
import { AccountManagement, exactCandidate, sameCandidate } from './management.ts';
import { NativeManagementClient } from './native-client.ts';
import { NativeAuthority } from './native-authority.ts';
import { NativeHTTPTransport } from './native-transport.ts';
import { createFacade, FacadeBearers, cancelFacadeTransport } from './facade.ts';
import type { FacadeOptions } from './facade.ts';
import { strictJSON } from './facade-ingress.ts';
import { object } from './native-wire.ts';
import { loadServiceConfig, keyBytes, ServiceError } from './service-config.ts';

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
export async function startService(configFile: string, signal?: AbortSignal): Promise<Service> {
  const cfg = loadServiceConfig(configFile); // Fully frozen before any await.
  const pool = new pg.Pool({ connectionString: cfg.kernelDSN, max: 8, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
  pool.on('error', () => fail());
  const kernel = new PostgresKernel(pool, undefined, cfg.durableFacts), worker = randomUUID(), ctx = Object.freeze({ consumerId: cfg.consumer.consumerId });
  const custody = new IntentSecrets(keyBytes(cfg.keys.intentAEAD), keyBytes(cfg.keys.intentHMAC));
  const store = new PostgresManagementStore(pool, custody);
  const bearers = new FacadeBearers(cfg.bearers), p = cfg.profile;
  const native = new NativeManagementClient({ origin: cfg.native.origin, consumerId: ctx.consumerId,
    controlCredential: cfg.consumer.managementCredential });
  const management = new AccountManagement({ kernel, store, custody, native, worker, profiles: [p], proof: {
    async verify(j, d) {
      const rows = await native.read(j);
      return rows.length === 1 && rows[0].state === 'inactive' && exactCandidate(j, d) &&
        exactCandidate(j, rows[0]) && sameCandidate(d, rows[0]) && j.profile.profile === p.profile &&
        j.profile.model === p.model && j.profile.baseURL === p.baseURL && j.profile.qualificationRef === p.qualificationRef;
    },
  } });
  let handler: Server | undefined, facade: Server | undefined;
  let original: ProcessBinding | undefined, ready = false, invalid = false, stopping = false;
  let terminal: 'retired' | 'pending' | undefined, retirement: Retirement | undefined;
  let child: ReturnType<typeof spawn> | undefined, options: FacadeOptions | undefined;
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
  let inFlightTick: Promise<void> = Promise.resolve(), enrollmentWaiters = 0;
  let wakeSleep: (() => void) | undefined;
  function denyAdmission() { bearers.replace([]); facade?.closeAllConnections(); }
  function fail() { invalid = true; denyAdmission(); pulse(); void stop(); }
  const callback = createServer({ maxHeaderSize: 16_384, headersTimeout: 5000, requestTimeout: 5000,
    keepAliveTimeout: 1000, connectionsCheckingInterval: 100 }, (req, res) => {
    // Go's first enrollment can arrive before stdout's actual starting binding.
    // Hold only this bounded listener; never ACK a synthetic authority.
    const timer = setTimeout(() => { res.destroy(); req.destroy(); }, 5000);
    res.once('close', () => clearTimeout(timer));
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
  callback.on('error', fail);
  function stop(): Promise<'retired' | 'pending'> {
    if (stopWork) return stopWork;
    if (stopping) return stopped;
    stopping = true; denyAdmission(); install(); pulse(); wakeSleep?.();
    // Signal only the original ChildProcess handle. The protected Go parent
    // alone decides exact-engine retirement and retains launcher disk evidence.
    if (child && !exited) {
      try { if (!child.kill('SIGTERM')) invalid = true; } catch { invalid = true; }
    }
    stopWork = (async () => {
      await Promise.all([close(facade), close(callback), close(handler)]);
      await bounded(Promise.all([maintenance, inFlightTick]), 6500).catch(() => { invalid = true; });
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
    child.once('error', () => { exited = true; exitResolve(); fail(); });
    child.once('exit', () => { exited = true; denyAdmission(); pulse(); if (!stopping) fail(); });
    child.once('close', code => {
      exitCode = code; exited = true; exitResolve(); denyAdmission(); pulse();
      if (!stopping) { invalid = true; void stop(); }
    });
    let diagnostics = 0, metadata = 0, buffer = Buffer.alloc(0), sequence = 0;
    child.stderr!.on('data', (b: Buffer) => { diagnostics += b.length; if (diagnostics > 65_536) fail(); });
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
            terminal = 'pending'; fail();
          } else throw new ServiceError('runtime_denied');
          pulse();
        }
        if (buffer.length > 4096) throw new ServiceError('runtime_denied');
      } catch { fail(); }
    });
    child.stdout!.once('end', () => { if (buffer.length || !terminal) fail(); });
    child.stdout!.on('error', fail); child.stderr!.on('error', fail);
    await waitFor(() => original !== undefined, 5000);
    startupActive();
    const binding = original!;
    const enrollment = Object.freeze({ originRef: binding.originRef, engineIncarnation: binding.incarnation, worker });
    const authority = new NativeAuthority({ kernel, store, config: { origin: cfg.native.origin,
      enrollment: { ...enrollment, qualificationRef: p.qualificationRef }, consumers: [cfg.consumer],
      profiles: [{ ...p, requestBytes: p.limits.requestBytes, outputBytes: p.limits.outputBytes,
        tokens: p.limits.tokens }], timeoutMs: 5000, closureWaitMs: 1000, maxPending: 128 } });
    handler = authority.createServer(); install();
    await waitFor(() => ready, 10_000);
    startupActive();
    await kernel.heartbeat(ctx, worker);
    startupActive();
    options = { kernel, management, store, bearers, enrollment, transport: new NativeHTTPTransport(authority),
      profiles: [{ dto: { profileId: p.profile, protocol: 'openai-responses', modelIds: [p.model], authKinds: ['api_key'] },
        maxOutputTokens: p.limits.tokens }], intentHmacKey: keyBytes(cfg.keys.facadeHMAC), ingressBytes: Math.max(1024, p.limits.requestBytes),
      bufferBytes: 65_536 };
    facade = createFacade(options); facade.on('error', fail);
    await listen(facade, cfg.facadeOrigin);
    startupActive();
    async function tick(): Promise<void> {
        await kernel.heartbeat(ctx, worker);
        if (stopping) return;
        await management.reconcile(ctx);
        if (stopping) return;
        const claim = await kernel.claimCleanup(ctx, worker);
        if (stopping) return; // An acquired lease remains outstanding until expiry.
        if (claim?.scope.kind === 'generation') await management.cleanupClaim(ctx, claim);
        else if (claim) {
          let closed = true;
          if (claim.scope.transports.length > 2) closed = false;
          for (const t of claim.scope.transports.slice(0, 2)) {
            if (stopping) { closed = false; break; }
            if (!t.native || !t.token || t.native.originRef !== binding.originRef || t.native.engineIncarnation !== binding.incarnation) { closed = false; continue; }
            try { await cancelFacadeTransport(options!, ctx, { ...t, native: t.native, token: t.token }, claim); }
            catch { closed = false; }
          }
          await kernel.settleCleanup(ctx, claim.cleanupRef, worker, claim.token, closed);
        }
    }
    maintenance = (async () => {
      while (!stopping) {
        inFlightTick = tick();
        await bounded(inFlightTick, 15_000);
        if (!stopping) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wakeSleep = undefined; resolve(); }, 1000);
          wakeSleep = () => { clearTimeout(timer); wakeSleep = undefined; resolve(); };
        });
      }
    })().catch(fail);
    return Object.freeze({ binding, stopped, stop });
  } catch {
    await stop();
    // A listen already in flight at cancellation can finish after stop's snapshot.
    await Promise.all([close(facade), close(callback), close(handler)]);
    throw new ServiceError('startup_denied');
  }
}
