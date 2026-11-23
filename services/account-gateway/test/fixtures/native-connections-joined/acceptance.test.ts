import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptedBaselineRows,
  acceptedBatchRows,
  baselineRowIds,
  isExpectedUnavailableReview,
  unavailableReviewRow,
} from "./acceptance.ts";

const expectedRowIds = [
  ...Array.from({ length: 52 }, (_, i) => `profile-${i}/api_key/provider_api_key`),
  unavailableReviewRow,
];
const passed = expectedRowIds.map((rowId) => ({
  rowId,
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

await test("52 completed reviews and an unavailable TypeSafe row do not complete the baseline", () => {
  const rows = [...passed.slice(0, 52), unavailable];
  const retained = structuredClone(rows);
  assert.equal(isExpectedUnavailableReview(unavailable), true);
  assert.equal(acceptedBatchRows(rows), false);
  assert.equal(acceptedBaselineRows(rows, expectedRowIds), false);
  assert.deepEqual(
    rows,
    retained,
    "negative capability evidence and successful reviews remain intact",
  );
});

await test("all 53 original identities must complete actual enrollment and review", () => {
  assert.equal(acceptedBatchRows(passed), true);
  assert.equal(acceptedBaselineRows(passed, expectedRowIds), true);
  assert.equal(isExpectedUnavailableReview(passed[52]), false);
  assert.equal(acceptedBaselineRows(passed.toReversed(), expectedRowIds), true);
});

await test("a missing, duplicated, or substituted row cannot qualify by count", () => {
  assert.equal(acceptedBaselineRows(passed.slice(1), expectedRowIds), false);
  assert.equal(acceptedBaselineRows([...passed.slice(1), passed[1]], expectedRowIds), false);
  assert.equal(
    acceptedBaselineRows(
      [{ ...passed[0], rowId: "unlisted/api_key/provider_api_key" }, ...passed.slice(1)],
      expectedRowIds,
    ),
    false,
  );
  assert.equal(acceptedBaselineRows(passed, expectedRowIds.slice(1)), false);
  assert.equal(
    acceptedBaselineRows(passed, [...expectedRowIds.slice(1), expectedRowIds[1]]),
    false,
  );
});

await test("a passed outcome cannot substitute for enrollment or a completed review", () => {
  for (const row of [
    { ...passed[0], enrolled: false },
    { ...passed[0], review: "not_requested" },
    { ...passed[0], review: "not_run" },
    { ...passed[0], review: "failed" },
    { ...passed[0], outcome: "failed" },
    { ...passed[0], outcome: "blocked" },
  ]) {
    const rows = [row, ...passed.slice(1)];
    assert.equal(acceptedBatchRows(rows), false);
    assert.equal(acceptedBaselineRows(rows, expectedRowIds), false);
  }
});

await test("independent successful batches remain valid without replacing baseline rows", () => {
  const extension = [
    {
      ...passed[0],
      rowId: "fixture-native-extension-responses-v1/fixture_browser_v1/same_consumer_build",
    },
  ];
  assert.equal(acceptedBatchRows(extension), true);
  assert.equal(acceptedBaselineRows(extension, expectedRowIds), false);
  assert.equal(acceptedBatchRows([]), false);
  assert.equal(acceptedBatchRows([passed[0], passed[0]]), false);
  assert.equal(acceptedBatchRows([unavailable]), false);
});

await test("only the actual unavailable capability outcome is classified as that evidence", () => {
  for (const row of [
    { ...unavailable, rowId: "other" },
    { ...unavailable, enrolled: true },
    { ...unavailable, review: "passed" },
    { ...unavailable, failure: { at: "rr-enrollment", error: "other" } },
    { ...unavailable, failure: { at: "other", error: "native_systemone_protocol" } },
  ]) {
    assert.equal(isExpectedUnavailableReview(row), false);
    assert.equal(acceptedBatchRows([row]), false);
  }
});

await test("expected identities come from the independent Native inventory", () => {
  const inventory = {
    schema: "native-parity-inventory/v1",
    sourceRepository: "agent-teams-ai/sub2api-standalone",
    rows: expectedRowIds.map((rowId) => {
      const [profileId, methodId, credentialVariant] = rowId.split("/");
      return { profileId, methodId, credentialVariant };
    }),
  };
  assert.deepEqual(baselineRowIds(inventory), expectedRowIds);
  assert.equal(acceptedBaselineRows(passed, baselineRowIds(inventory)), true);
  for (const invalid of [
    null,
    { ...inventory, schema: "other" },
    { ...inventory, sourceRepository: "other" },
    { ...inventory, rows: null },
    { ...inventory, rows: inventory.rows.slice(1) },
    { ...inventory, rows: [...inventory.rows.slice(1), inventory.rows[1]] },
    { ...inventory, rows: [null, ...inventory.rows.slice(1)] },
    {
      ...inventory,
      rows: [
        { ...inventory.rows[0], credentialVariant: "other/variant" },
        ...inventory.rows.slice(1),
      ],
    },
  ]) {
    assert.throws(() => baselineRowIds(invalid));
  }
});
