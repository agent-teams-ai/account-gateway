import test from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../packages/account-gateway/dist/contracts/index.js";

const preparation = (accountRefs) => ({
  operationId: "operation-a",
  invocationRef: "invocation-a",
  attemptRef: "attempt-a",
  accountRefs,
  subjectRef: "subject-a",
  policyRevision: 1,
  bindingRevision: 1,
  profileId: "mimo",
  limits: { requests: 5, requestBytes: 4096, outputBytes: 4096, tokens: 1000, concurrency: 1 },
  deadline: "2030-01-01T00:00:00Z",
});

// Regression: checking the collection limit after its elements permits an
// oversized invalid input to allocate one validation issue per element.
// Element getters observe actual public-contract parsing without allocating a
// large input or relying on timing, heap measurements or schema internals.
test("prepare rejects oversized accountRefs before reading any element", () => {
  const boundary = Array.from({ length: 100 }, (_, index) => `account-${index}`);
  assert.deepEqual(prepare.parse(preparation(boundary)).accountRefs, boundary);
  assert.equal(prepare.safeParse(preparation([])).success, false);

  let elementReads = 0;
  const oversized = new Array(101);
  for (let index = 0; index < oversized.length; index++) {
    Object.defineProperty(oversized, index, {
      enumerable: true,
      get() {
        elementReads++;
        return null;
      },
    });
  }
  const result = prepare.safeParse(preparation(oversized));
  assert.equal(result.success, false);
  assert.equal(
    elementReads,
    0,
    "the collection cap must reject before per-element validation work",
  );
  assert.deepEqual(
    result.error.issues.map((issue) => ({ code: issue.code, path: issue.path })),
    [{ code: "too_big", path: ["accountRefs"] }],
  );
});
