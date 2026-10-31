import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { KernelError } from "../src/domain.ts";
import {
  operationStatus,
  captureClosure,
  dispatchProof,
  transportClosure,
  captureOwnerRefs,
  capturePermittedAccounts,
  type OperationRow,
  type TransportRow,
} from "../src/postgres-records.ts";

const unavailable = (work: () => unknown): void => {
  assert.throws(
    work,
    (error: unknown) => error instanceof KernelError && error.code === "unavailable",
  );
};
const invalid = (work: () => unknown): void => {
  assert.throws(work, (error: unknown) => error instanceof KernelError && error.code === "invalid");
};

void test("persisted lifecycle snapshots bind the account and whitelist domain facts", () => {
  const accountRef = randomUUID();
  const account = {
    accountRef,
    ownerRef: "synthetic-owner",
    profile: "synthetic-profile",
    displayName: "Sample",
    state: "active",
    revision: 3,
    epoch: 2,
    token: "must-not-leak",
  };
  const row: OperationRow = {
    id: randomUUID(),
    state: "applied",
    code: null,
    account_ref: accountRef,
    execution_ref: null,
    revision: 3,
    epoch: 2,
    deadline: null,
    intent: { kind: "suspend", expectedRevision: 2, credential: "must-not-leak" },
    lifecycle_result: account,
  };
  const result = operationStatus(row);
  assert.deepEqual(result.lifecycle, {
    kind: "suspend",
    expectedRevision: 2,
    account: {
      accountRef,
      ownerRef: "synthetic-owner",
      profile: "synthetic-profile",
      displayName: "Sample",
      state: "active",
      revision: 3,
      epoch: 2,
    },
  });
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
  for (const lifecycle_result of [
    { ...account, accountRef: randomUUID() },
    { ...account, ownerRef: "" },
    { ...account, state: "deleted" },
    { ...account, revision: 0 },
    [account],
  ]) {
    unavailable(() => operationStatus({ ...row, lifecycle_result }));
  }
  unavailable(() => operationStatus({ ...row, intent: { kind: "resume", expectedRevision: -1 } }));
});

void test("incomplete native proofs never upgrade legacy closure evidence", () => {
  const native = {
    originRef: "synthetic-native-origin",
    engineIncarnation: randomUUID(),
    requestNonce: randomUUID(),
    generation: randomUUID(),
  };
  const row: TransportRow = {
    execution_ref: randomUUID(),
    id: "synthetic-request",
    worker: randomUUID(),
    closure_token: randomUUID(),
    native_origin_ref: native.originRef,
    engine_incarnation: native.engineIncarnation,
    request_nonce: native.requestNonce,
    descriptor_generation: native.generation,
  };
  assert.deepEqual(dispatchProof(row), {
    executionRef: row.execution_ref,
    requestRef: row.id,
    worker: row.worker,
    token: row.closure_token,
    native,
  });
  unavailable(() => dispatchProof({ ...row, engine_incarnation: null }));
  unavailable(() => dispatchProof({ ...row, closure_token: null }));
  const legacy = transportClosure({
    ...row,
    native_origin_ref: null,
    closure_token: null,
  });
  assert.deepEqual(legacy, {
    executionRef: row.execution_ref,
    requestRef: row.id,
    worker: row.worker,
  });
  invalid(() => captureClosure({ ...legacy, native: { ...native, generation: "invalid" } }));
  invalid(() => captureClosure({ ...legacy, token: "invalid-token" }));
});

void test("persisted owner and account selector capture copies and validates input", () => {
  const ownerRefs = ["synthetic-owner"];
  const captured = captureOwnerRefs(ownerRefs);
  assert.deepEqual(captured, ownerRefs);
  ownerRefs.push("other-owner");
  assert.deepEqual(captured, ["synthetic-owner"]);
  assert.equal(Object.isFrozen(captured), true);
  const accountRef = randomUUID();
  const accounts = [accountRef];
  const permitted = capturePermittedAccounts(accounts);
  accounts[0] = randomUUID();
  assert.deepEqual(permitted, [accountRef]);
  invalid(() => captureOwnerRefs([123]));
  invalid(() => capturePermittedAccounts([]));
  invalid(() => capturePermittedAccounts(["not-uuid"]));
});
