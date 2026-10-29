import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { NativeAuthority } from "../src/native-authority.ts";
import { FacadeBearers } from "../src/facade.ts";
import type { RunControlBearer } from "../src/facade.ts";
import type { ExecutionRead, SavedExecution } from "../src/domain.ts";

const policy = (): RunControlBearer => ({
  token: "synthetic-control-" + randomUUID(),
  role: "run-control",
  consumerId: "synthetic-consumer",
  ownerRefs: ["synthetic-owner"],
  profileIds: ["synthetic-profile"],
  maxRunMs: 60000,
  limits: { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 },
});
const saved = (): SavedExecution => ({
  generation: randomUUID(),
  state: "open",
  dispatchAllowed: true,
  admission: {
    executionRef: randomUUID(),
    issuerEpoch: randomUUID(),
    invocationRef: "synthetic-invocation",
    attemptRef: "synthetic-attempt",
    accountRef: randomUUID(),
    authorizationEpoch: 1,
    subjectRef: "synthetic-subject",
    policyRevision: 2,
    bindingRevision: 3,
    profileId: "synthetic-profile",
    limits: { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
});
function fixture(control = policy(), key = randomBytes(32)) {
  const bearers = new FacadeBearers([control]);
  bearers.configureExecutionKey(key);
  const issuer = bearers.resolve(control.token);
  assert.ok(issuer && issuer.role === "run-control");
  const rows = new Map<string, SavedExecution>();
  let reads = 0;
  const kernel = {
    async savedExecution(context: { consumerId: string }, ref: string) {
      reads++;
      assert.equal(context.consumerId, control.consumerId);
      const row = rows.get(ref);
      assert.ok(row);
      return row;
    },
  } as ExecutionRead;
  const mint = (row = saved()) => {
    rows.set(row.admission.executionRef, row);
    return { token: bearers.upsertExecution(issuer, row), row };
  };
  return { control, key, bearers, issuer, rows, kernel, mint, reads: () => reads };
}

void test("execution issuance exceeds historical registry limit and hydrates stable fenced tuples after restart", async () => {
  const f = fixture();
  const issued = Array.from({ length: 300 }, () => f.mint());
  assert.equal(new Set(issued.map((x) => x.token)).size, 300);
  for (const { token, row } of [issued[0], issued[127], issued[299]]) {
    assert.equal(f.bearers.upsertExecution(f.issuer, row), token);
    const next = new FacadeBearers([f.control]);
    next.configureExecutionKey(f.key);
    f.rows.set(row.admission.executionRef, { ...row, state: "fenced", dispatchAllowed: false });
    const grant = await next.resolveExecution(token, f.kernel);
    assert.ok(grant && grant.role === "execution");
    assert.equal(grant.saved.dispatchAllowed, false);
    assert.equal(grant.saved.state, "fenced");
    assert.ok(next.current(grant));
    next.replace([]);
    assert.equal(next.current(grant), false);
    assert.equal(await next.resolveExecution(token, f.kernel), undefined);
  }
});

void test("execution capability binds signing key, configured issuer token/policy, consumer and original admission", async () => {
  const f = fixture(),
    { token, row } = f.mint();
  const grant = await f.bearers.resolveExecution(token, f.kernel);
  assert.ok(grant);
  for (const replacement of [
    { ...f.control, token: "rotated-control-" + randomUUID() },
    { ...f.control, ownerRefs: ["different-owner"] },
    { ...f.control, consumerId: "different-consumer" },
  ]) {
    const changed = new FacadeBearers([replacement]);
    changed.configureExecutionKey(f.key);
    assert.equal(await changed.resolveExecution(token, f.kernel), undefined);
  }
  const wrongKey = new FacadeBearers([f.control]);
  wrongKey.configureExecutionKey(randomBytes(32));
  assert.equal(await wrongKey.resolveExecution(token, f.kernel), undefined);
  const before = f.reads();
  const changed = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(await f.bearers.resolveExecution(changed, f.kernel), undefined);
  assert.equal(f.reads(), before);
  f.rows.set(row.admission.executionRef, {
    ...row,
    admission: { ...row.admission, authorizationEpoch: 2 },
  });
  assert.equal(await f.bearers.resolveExecution(token, f.kernel), undefined);
});

void test("legacy configured execution credentials remain scoped while expired minted capabilities cannot be issued", async () => {
  const f = fixture(),
    row = saved();
  const legacy = new FacadeBearers([
    {
      token: "synthetic-execution-" + randomUUID(),
      role: "execution",
      consumerId: f.control.consumerId,
      saved: row,
    },
  ]);
  assert.equal(legacy.resolve(f.control.token), undefined);
  assert.throws(() =>
    f.mint({
      ...row,
      admission: { ...row.admission, expiresAt: new Date(Date.now() - 1).toISOString() },
    }),
  );
});

const build = (concurrency: number) =>
  new NativeAuthority({
    kernel: {} as never,
    store: {} as never,
    profileLimits: [
      {
        profile: "profile",
        limits: {
          requests: 128,
          concurrency,
          requestBytes: 4096,
          outputBytes: 4096,
          tokens: 100,
        },
      },
    ],
    config: {
      origin: "http://127.0.0.1:1",
      enrollment: {
        originRef: "synthetic-origin",
        engineIncarnation: randomUUID(),
        worker: randomUUID(),
        qualificationRef: "synthetic",
      },
      consumers: [
        {
          consumerId: "synthetic-consumer",
          executionCredential: "synthetic-execution-token",
          cleanupCredential: "synthetic-cleanup-token",
          callbackCredential: "synthetic-callback-token",
        },
      ],
      profiles: [
        {
          profile: "profile",
          baseURL: "https://fixture.invalid",
          model: "synthetic-model",
          qualificationRef: "synthetic",
          requestBytes: 4096,
          outputBytes: 4096,
          tokens: 100,
          providerTokenUpperBound: 100,
        },
      ],
    },
  });

void test("trusted native profile limits accept approved64 concurrency while rejecting65", () => {
  assert.doesNotThrow(() => build(32));
  assert.doesNotThrow(() => build(64));
  assert.throws(() => build(65));
});
