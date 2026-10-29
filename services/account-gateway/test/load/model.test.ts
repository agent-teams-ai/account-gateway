import test from "node:test";
import assert from "node:assert/strict";
import { identifier, reconcile, closureProjection, safeError } from "./model.ts";
import type { Attempt, LedgerEvent, Proof } from "./model.ts";

void test("independent provider reconciliation refuses duplicates, false no-spend and missing closure", () => {
  const a: Attempt = {
    requestId: "r",
    executionRef: "e",
    accountRef: "a",
    scenario: "smoke",
    mode: "sdk",
    offeredAt: 1,
    startedAt: 1,
    bytes: 0,
    effect: "not_dispatched",
    occupied: false,
  };
  const e: LedgerEvent = { event: "entry", requestId: "r", at: 1, bytes: 0, sequence: 1 };
  assert.deepEqual(reconcile(a, []), []);
  assert.ok(reconcile(a, [e]).includes("denial-entered-provider"));
  assert.ok(reconcile({ ...a, effect: "completed" }, [e, e]).includes("duplicate-provider-entry"));
  assert.ok(reconcile({ ...a, effect: "completed" }, [e]).includes("missing-exact-native-closure"));
  assert.deepEqual(
    reconcile(
      {
        ...a,
        effect: "completed",
        response: "stream",
        validatedStream: true,
        exactProof: true,
        nativeClosed: true,
        nativeAcknowledged: true,
      },
      [e],
    ),
    [],
  );
  assert.ok(
    reconcile(
      {
        ...a,
        effect: "completed",
        response: "error",
        exactProof: true,
        nativeClosed: true,
        nativeAcknowledged: true,
      },
      [e],
    ).includes("unexpected-effect-or-client-stream-failure"),
  );
  assert.ok(
    reconcile({ ...a, effect: "effect_unknown" }, [e]).includes(
      "unexpected-effect-or-client-stream-failure",
    ),
  );
  assert.ok(
    !reconcile({ ...a, effect: "effect_unknown", intentionalCancel: "raw-disconnect" }, [
      e,
    ]).includes("unexpected-effect-or-client-stream-failure"),
  );
});
void test("closure needs original full proof and physical body closure independently of effect", () => {
  const p: Proof = {
    executionRef: "e",
    requestRef: "r",
    worker: "w",
    token: "private",
    native: { originRef: "o", engineIncarnation: "i", requestNonce: "n", generation: "g" },
  };
  const r = {
    consumerId: "c",
    executionRef: "e",
    requestRef: "r",
    proof: p,
    native: p.native,
    phase: "closed",
    acknowledged: true,
    lifetime: {
      contextDone: true,
      forwardingReturned: true,
      bodyKnown: true,
      bodyClosed: true,
      closeFailed: false,
    },
  };
  assert.deepEqual(closureProjection(r, "c", p), {
    exactProof: true,
    nativeClosed: true,
    nativeAcknowledged: true,
  });
  assert.equal(
    closureProjection({ ...r, proof: { ...p, token: "forged" } }, "c", p).exactProof,
    false,
  );
  assert.equal(
    closureProjection({ ...r, proof: { ...p, native: null } }, "c", p).exactProof,
    false,
  );
  assert.deepEqual(closureProjection(null, "c", p), {
    exactProof: false,
    nativeClosed: false,
    nativeAcknowledged: false,
  });
  assert.equal(
    closureProjection({ ...r, native: { ...p.native, requestNonce: "neighbor" } }, "c", p)
      .exactProof,
    false,
  );
  assert.equal(
    closureProjection({ ...r, lifetime: { ...r.lifetime, bodyClosed: false } }, "c", p)
      .nativeClosed,
    false,
  );
});
void test("seeded request identities repeat only for the same complete run tuple; diagnostics discard private error bodies", () => {
  const id = identifier("run", 42, 3);
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id, identifier("run", 42, 3));
  assert.notEqual(id, identifier("run", 43, 3));
  assert.notEqual(id, identifier("other-run", 42, 3));
  assert.equal(safeError(new Error("secret provider body")), "unclassified-failure");
  assert.equal(safeError(new Error("load:bounded-input")), "bounded-input");
});
