import test from 'node:test';
import assert from 'node:assert/strict';
import { identifier, reconcile, closureProjection, safeError, arrivalObservation } from './model.ts';
import type { Attempt, LedgerEvent, Proof } from './model.ts';

test('independent provider reconciliation refuses duplicates, false no-spend and missing closure', () => {
  const a: Attempt = { requestId: 'r', executionRef: 'e', accountRef: 'a', scenario: 'smoke', mode: 'sdk',
    offeredAt: 1, startedAt: 1, bytes: 0, effect: 'not_dispatched', sqlCode: 'concurrency_limit', occupied: false };
  const e: LedgerEvent = { event: 'entry', requestId: 'r', at: 1, bytes: 0, sequence: 1 };
  assert.deepEqual(reconcile(a, []), []);
  assert.ok(reconcile(a, [e]).includes('denial-entered-provider'));
  assert.ok(reconcile({ ...a, effect: 'completed' }, [e, e]).includes('duplicate-provider-entry'));
  assert.ok(reconcile({ ...a, effect: 'completed' }, [e]).includes('missing-exact-native-closure'));
  assert.deepEqual(reconcile({ ...a, effect: 'completed', response: 'stream', validatedStream: true,
    exactProof: true, nativeClosed: true, nativeAcknowledged: true }, [e]), []);
  assert.ok(reconcile({ ...a, effect: 'completed', response: 'error', exactProof: true, nativeClosed: true, nativeAcknowledged: true }, [e])
    .includes('unexpected-effect-or-client-stream-failure'));
  assert.ok(reconcile({ ...a, effect: 'effect_unknown' }, [e]).includes('unexpected-effect-or-client-stream-failure'));
  assert.ok(!reconcile({ ...a, effect: 'effect_unknown', intentionalCancel: 'raw-disconnect' }, [e]).includes('unexpected-effect-or-client-stream-failure'));
});
test('closure needs original full proof and physical body closure independently of effect', () => {
  const p: Proof = { executionRef: 'e', requestRef: 'r', worker: 'w', token: 'private',
    native: { originRef: 'o', engineIncarnation: 'i', requestNonce: 'n', generation: 'g' } };
  const r = { consumerId: 'c', executionRef: 'e', requestRef: 'r', proof: p, native: p.native,
    phase: 'closed', acknowledged: true, lifetime: { contextDone: true, forwardingReturned: true, bodyKnown: true, bodyClosed: true, closeFailed: false } };
  assert.deepEqual(closureProjection(r, 'c', p), { exactProof: true, nativeClosed: true, nativeAcknowledged: true });
  assert.equal(closureProjection({ ...r, proof: { ...p, token: 'forged' } }, 'c', p).exactProof, false);
  assert.equal(closureProjection({ ...r, native: { ...p.native, requestNonce: 'neighbor' } }, 'c', p).exactProof, false);
  assert.equal(closureProjection({ ...r, lifetime: { ...r.lifetime, bodyClosed: false } }, 'c', p).nativeClosed, false);
});
test('seeded request identities repeat only for the same complete run tuple; diagnostics discard private error bodies', () => {
  const id = identifier('run', 42, 3);
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id, identifier('run', 42, 3)); assert.notEqual(id, identifier('run', 43, 3));
  assert.notEqual(id, identifier('other-run', 42, 3));
  assert.equal(safeError(new Error('secret provider body')), 'unclassified-failure');
  assert.equal(safeError(new Error('load:bounded-input')), 'bounded-input');
});
test('arrival evidence distinguishes its target from delayed actual SDK starts and positively classified refusals', () => {
  const base: Attempt = { requestId: 'r', executionRef: 'e', accountRef: 'a', scenario: 'scale-arrivals', mode: 'sdk',
    offeredAt: 0, startedAt: 100, bytes: 0, effect: 'completed' };
  const observation = arrivalObservation([base, { ...base, offeredAt: 100, startedAt: 200, effect: 'not_dispatched', sqlCode: 'concurrency_limit' },
    { ...base, offeredAt: 200, startedAt: 400 }], 10, 0, 700);
  assert.equal(observation.targetRate, 10);
  assert.equal(observation.observedOfferedRate, 2000 / 300);
  assert.equal(observation.maximumLaunchLagMs, 200);
  assert.equal(observation.offerWindowMs, 300);
  assert.equal(observation.safeRefusals, 1); assert.equal(observation.completed, 2); assert.equal(observation.unsettledOrFailed, 0);
  const ambiguous = arrivalObservation([{ ...base, effect: 'effect_unknown' }], 1000, 0, 700);
  assert.equal(ambiguous.safeRefusals, 0); assert.equal(ambiguous.unsettledOrFailed, 1);
  assert.equal(ambiguous.observedOfferedRate, 0, 'one observation cannot establish a start rate');
});
test('authorization and validation failures cannot masquerade as workload capacity refusals', () => {
  const attempt: Attempt = { requestId: 'r', executionRef: 'e', accountRef: 'a', scenario: 'scale-arrivals', mode: 'sdk',
    offeredAt: 0, startedAt: 1, bytes: 0, preclaimRefused: true, safeCode: 'admission_limited' };
  assert.deepEqual(reconcile(attempt, []), []);
  for (const safeCode of ['forbidden', 'invalid_request', 'unauthenticated']) {
    const wrong = { ...attempt, safeCode };
    assert.ok(reconcile(wrong, []).includes('unexpected-preclaim-refusal'));
    assert.equal(arrivalObservation([wrong], 1000, 0, 10).safeRefusals, 0);
  }
  for (const sqlCode of ['fenced', 'deadline', 'limit']) assert.ok(reconcile({ ...attempt,
    preclaimRefused: false, effect: 'not_dispatched', sqlCode }, []).includes('unexpected-durable-refusal'));
});
