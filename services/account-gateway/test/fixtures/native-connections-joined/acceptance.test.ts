import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedBaselineRows, acceptedBatchRows, unavailableReviewRow } from "./acceptance.ts";

const passed = Array.from({ length: 52 }, (_, i) => ({
  rowId: `supported-${i}`,
  outcome: "passed",
  enrolled: true,
  review: "passed",
}));
const unavailable = {
  rowId: unavailableReviewRow,
  outcome: "blocked",
  enrolled: false,
  review: "not_requested",
  failure: { at: "rr-enrollment", error: "native_systemone_protocol" },
};

await test("accepts 52 actual reviews and the verified unavailable TypeSafe row", () => {
  assert.equal(acceptedBatchRows([...passed, unavailable]), true);
  assert.equal(acceptedBaselineRows([...passed, unavailable]), true);
});

await test("rejects missing, duplicated, unexpected or unverified unavailable rows", () => {
  assert.equal(acceptedBaselineRows(passed), false);
  assert.equal(acceptedBaselineRows([...passed.slice(1), passed[1], unavailable]), false);
  for (const row of [
    { ...unavailable, rowId: "other" },
    { ...unavailable, enrolled: true },
    { ...unavailable, review: "passed" },
    { ...unavailable, failure: { at: "rr-enrollment", error: "other" } },
    { ...unavailable, failure: { at: "other", error: "native_systemone_protocol" } },
  ]) {
    assert.equal(acceptedBatchRows([row]), false);
    assert.equal(acceptedBaselineRows([...passed, row]), false);
  }
  assert.equal(
    acceptedBaselineRows([
      { ...passed[0], review: "not_requested" },
      ...passed.slice(1),
      unavailable,
    ]),
    false,
  );
  assert.equal(
    acceptedBaselineRows([{ ...passed[0], outcome: "failed" }, ...passed.slice(1), unavailable]),
    false,
  );
});
