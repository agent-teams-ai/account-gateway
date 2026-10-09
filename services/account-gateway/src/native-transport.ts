import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelError } from './domain.ts';
import { inServiceLane } from './service-admission.ts';
import type { CleanupAuthority, NativeDispatchProof, TrustedContext } from './domain.ts';
import type { NativeTransport } from './facade.ts';
import type { NativeAuthority } from './native-authority.ts';
import type { Association } from './native-authority.ts';
import { denied, instant, jsonBody, now, physicallyClosed, post, proof, receipt, singleton } from './native-wire.ts';
import type { CleanupLease, Receipt } from './native-wire.ts';

const path = '/private/native/v1/transports';
export class NativeHTTPTransport implements NativeTransport {
  readonly #authority: NativeAuthority;
  constructor(authority: NativeAuthority) { this.#authority = authority; }
  async #control(ctx: TrustedContext, p: NativeDispatchProof, action: 'read-owner' | 'cancel-owner' | 'ack-owner' | 'read' | 'cancel' | 'ack', c?: CleanupLease): Promise<Receipt> {
    const authority = this.#authority, cfg = authority.configuration, consumer = authority.consumer(ctx);
    await authority.persisted(ctx, p);
    if (c) await authority.delegated(ctx, p, c);
    const hop = await post(cfg, c ? consumer.cleanupCredential : consumer.executionCredential,
      path + '/' + action, Buffer.from(JSON.stringify({ proof: p, ...(c ? { cleanup: c } : {}) })));
    try {
      if (hop.response.statusCode !== 202 || singleton(hop.response, 'content-type') !== 'application/json' ||
          hop.response.rawHeaders.some((h, i) => i % 2 === 0 && h.toLowerCase() === 'content-encoding')) return denied();
      return receipt(await jsonBody(hop.response, cfg.controlBytes), ctx.consumerId, p);
    } finally { hop.abort(); }
  }
  async #recover(a: Association): Promise<NativeDispatchProof | undefined> {
    if (a.proof) return a.proof;
    const actual = await this.#authority.kernel.requestProof(a.context, a.saved.admission.executionRef, a.requestId);
    if (actual) {
      const p = proof(actual); await this.#authority.persisted(a.context, p);
      if (p.native.generation !== a.saved.generation || a.native && p.native.requestNonce !== a.native.requestNonce) return denied();
      a.proof = p;
    }
    return a.proof;
  }
  async #unknown(a: Association): Promise<void> {
    try {
      const p = await this.#recover(a);
      if (p) { await a.callback.effect(p, 'effect_unknown'); return; }
    } catch { /* An uncertain claim/effect write needs the existing close fence. */ }
    a.closeRef ??= randomUUID();
    await this.#authority.kernel.close(a.context, a.closeRef, a.saved.admission.executionRef);
  }
  async #settle(a: Association, initial?: Receipt, interrupted = false): Promise<void> {
    const authority = this.#authority, cfg = authority.configuration, p = await this.#recover(a);
    if (!p) {
      if (a.admitStarted) await this.#unknown(a);
      return;
    }
    let r = initial;
    const deadline = Date.now() + cfg.closureWaitMs;
    while (!r || !physicallyClosed(r)) {
      r = await this.#control(a.context, p, 'read-owner');
      if (physicallyClosed(r)) break;
      if (Date.now() >= deadline) return denied();
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    const status = await authority.kernel.request(a.context, p.executionRef, p.requestRef);
    if (interrupted) await this.#unknown(a);
    else if (!r.lifetime.entered) {
      // An authenticated positive no-entry receipt spends the original claim;
      // neither HTTP failure nor missing readback is a non-entry fact.
      if (status.effect === 'dispatch_started') await a.callback.rejectBeforeDispatch(p, false);
    } else if (r.lifetime.completed && r.effect === 'completed') {
      if (status.effect === 'dispatch_started') await a.callback.effect(p, 'response_started');
      const current = await authority.kernel.request(a.context, p.executionRef, p.requestRef);
      if (current.effect === 'response_started') await a.callback.effect(p, 'completed');
    } else await this.#unknown(a);
    // The Go ack-owner performs the authenticated Node closure callback. Only
    // that callback durably releases SQL occupancy; EOF does not call closed().
    if (a.ackStarted) return denied(); // No automatic replay of an uncertain ACK.
    a.ackStarted = true;
    const ack = await this.#control(a.context, p, 'ack-owner');
    if (!physicallyClosed(ack) || !ack.acknowledged) return denied();
  }
  async request(input: Parameters<NativeTransport['request']>[0]): Promise<Awaited<ReturnType<NativeTransport['request']>>> {
    // Snapshot caller bytes and all routing authority before the first await.
    if (input.body.byteLength > 4_194_304) return denied();
    const bytes = new Uint8Array(input.body), authority = this.#authority, cfg = authority.configuration;
    const { association: a, first } = authority.begin(input, bytes);
    if (!first) {
      // Reading the original SQL status is harmless. A live or uncertain route
      // association never sends another inference POST, even under a new signal.
      await authority.kernel.request(a.context, a.saved.admission.executionRef, a.requestId);
      return { kind: 'status' };
    }
    let envelope: Buffer;
    try {
      await authority.prepare(a, bytes);
      envelope = Buffer.concat([Buffer.from(JSON.stringify({ requestRef: a.requestId, worker: cfg.enrollment.worker,
        admission: a.saved.admission, descriptor: a.descriptor }).slice(0, -1) + ',"payload":'), bytes, Buffer.from('}')]);
      if (a.signal.aborted || instant(a.saved.admission.expiresAt) <= now()) return denied();
    } catch (error) {
      authority.reclaimUnstarted(a); throw error;
    }
    a.outboundStarted = true;
    let hop: Awaited<ReturnType<typeof post>> | undefined;
    let finished = false, cancellation: Promise<void> | undefined, responseUnknown: Promise<void> | undefined;
    const uncertain = () => inServiceLane('control', async () => { if (!finished) await this.#unknown(a); });
    const onResponseAbort = () => { responseUnknown ??= uncertain().catch(() => undefined); };
    const detach = () => {
      a.signal.removeEventListener('abort', onAbort);
      hop?.response.removeListener('aborted', onResponseAbort);
    };
    const settleRetained = async () => {
      detach();
      await Promise.all([cancellation?.catch(() => undefined), responseUnknown]);
    };
    const cancel = (): Promise<void> => {
      if (finished) return Promise.resolve();
      if (cancellation) return cancellation;
      cancellation = inServiceLane('control', async () => {
        hop?.abort();
        await uncertain();
        const p = await this.#recover(a);
        if (p) {
          const r = await this.#control(a.context, p, 'cancel-owner');
          await this.#settle(a, r, true);
        }
      }).finally(async () => { detach(); await responseUnknown; });
      return cancellation;
    };
    const onAbort = () => { void cancel().catch(() => undefined); };
    a.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const duration = Math.min(cfg.maxStreamMs, Math.max(1, Number((instant(a.saved.admission.expiresAt) - now()) / 1_000_000n)));
      hop = await post(cfg, authority.consumer(a.context).executionCredential, path, envelope, a.signal, duration);
      const response = hop.response;
      response.once('aborted', onResponseAbort);
      if (response.statusCode === 202 && singleton(response, 'content-type') === 'application/json') {
        // An early/lost-admit-ACK receipt is not physical closure. Drain only
        // bounded JSON, then read the sealed reservation with the original SQL
        // proof (which Go may not yet have attached to its receipt).
        await jsonBody(response, cfg.controlBytes);
        const p = await this.#recover(a);
        if (!p) {
          // A status-only admission has no dispatch proof. Verify actual SQL
          // readback; an uncertain first claim is conservatively fenced.
          await authority.reclaimDenied(a);
        } else await inServiceLane('control', () => this.#settle(a));
        finished = true; hop.abort(); await settleRetained(); return { kind: 'status' };
      }
      if (response.statusCode !== 200 || singleton(response, 'content-type')?.split(';')[0] !== 'text/event-stream' ||
          singleton(response, 'x-gateway-request-ref') !== a.requestId ||
          response.rawHeaders.some((h, i) => i % 2 === 0 && h.toLowerCase() === 'content-encoding') || !await this.#recover(a)) return denied();
      const transport = this, active = hop;
      return { kind: 'stream', cancel, body: (async function* () {
        let size = 0, started = false;
        try {
          for await (const chunk of response) {
            if (a.signal.aborted || cancellation) return denied();
            const b = new Uint8Array(chunk as Uint8Array); size += b.byteLength;
            if (size > a.saved.admission.limits.outputBytes) return denied();
            if (!started && b.byteLength) {
              started = true;
              const current = await authority.kernel.request(a.context, a.saved.admission.executionRef, a.requestId);
              if (current.effect === 'dispatch_started') await a.callback.effect(a.proof!, 'response_started');
            }
            yield b; // Pull-based Node iteration preserves backpressure.
          }
          if (!response.complete || a.signal.aborted || cancellation) return denied();
          await inServiceLane('control', () => transport.#settle(a));
          finished = true;
        } catch {
          await uncertain().catch(() => undefined);
          throw new KernelError('unavailable');
        } finally {
          active.abort();
          if (!finished) await cancel().catch(() => undefined);
          await settleRetained();
        }
      })() };
    } catch {
      hop?.abort(); a.signal.removeEventListener('abort', onAbort);
      await uncertain().catch(() => undefined);
      await settleRetained();
      throw new KernelError('unavailable');
    }
  }
  async cancel(context: TrustedContext, input: NativeDispatchProof, authority: CleanupAuthority): Promise<void> {
    const ctx = Object.freeze({ consumerId: context.consumerId }), p = proof(input);
    const cleanupRef = authority.cleanupRef, token = authority.token, worker = this.#authority.configuration.enrollment.worker;
    const expires = await this.#authority.kernel.currentCleanupLease(ctx, cleanupRef, worker, token);
    const c = { cleanupRef, token, worker, leaseExpiresAt: expires };
    let r = await this.#control(ctx, p, 'cancel', c);
    const until = Date.now() + this.#authority.configuration.closureWaitMs;
    while (!physicallyClosed(r)) {
      if (Date.now() >= until) return denied();
      await delay(25); r = await this.#control(ctx, p, 'read', c);
    }
    r = await this.#control(ctx, p, 'ack', c);
    if (!physicallyClosed(r) || !r.acknowledged) return denied();
  }
}
