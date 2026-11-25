import assert from "node:assert/strict";

/** An observed capability restriction never substitutes for a completed review. */
export const unavailableReviewRow = "typesafe-systemone-apikey-v1/api_key/provider_api_key";

/** Explicit owner decision; the original Native inventory remains unchanged. */
export const reviewAcceptance = {
  contract: "native-generative-review-acceptance/v1",
  ownerDecision: "2026-11-25-typesafe-exclusion",
  originalInventoryRows: 53,
  requiredReviewRows: 52,
  excludedReviewRowIds: [unavailableReviewRow],
} as const;

export type AcceptanceRow = {
  rowId: string;
  outcome: string;
  enrolled: boolean;
  review: string;
  failure?: { at: string; error: string };
};

export function isExpectedUnavailableReview(row: AcceptanceRow): boolean {
  return (
    row.rowId === unavailableReviewRow &&
    row.outcome === "blocked" &&
    typeof row.enrolled === "boolean" &&
    !row.enrolled &&
    row.review === "not_requested" &&
    row.failure?.at === "rr-enrollment" &&
    row.failure.error === "native_systemone_protocol"
  );
}

export function acceptedBatchRows(rows: readonly AcceptanceRow[]): boolean {
  return (
    rows.length > 0 &&
    new Set(rows.map((row) => row.rowId)).size === rows.length &&
    rows.every(
      (row) =>
        row.outcome === "passed" &&
        typeof row.enrolled === "boolean" &&
        row.enrolled &&
        row.review === "passed",
    )
  );
}

function hasBaselineInventoryRows(
  rows: readonly AcceptanceRow[],
  expectedRowIds: readonly string[],
): boolean {
  const expected = new Set(expectedRowIds);
  return (
    expectedRowIds.length === 53 &&
    expected.size === 53 &&
    rows.length === 53 &&
    rows.every((row) => expected.has(row.rowId))
  );
}

/** Preserve the original all-53 result separately from the owner's new scope. */
export function acceptedBaselineRows(
  rows: readonly AcceptanceRow[],
  expectedRowIds: readonly string[],
): boolean {
  return hasBaselineInventoryRows(rows, expectedRowIds) && acceptedBatchRows(rows);
}

/** TypeSafe remains an observed unsupported path, never a successful review. */
export function acceptedReviewBatchRows(rows: readonly AcceptanceRow[]): boolean {
  return (
    new Set(rows.map((row) => row.rowId)).size === rows.length &&
    rows.filter((row) => row.rowId === unavailableReviewRow).every(isExpectedUnavailableReview) &&
    acceptedBatchRows(rows.filter((row) => row.rowId !== unavailableReviewRow))
  );
}

export function acceptedRequiredReviewRows(
  rows: readonly AcceptanceRow[],
  expectedRowIds: readonly string[],
): boolean {
  return (
    hasBaselineInventoryRows(rows, expectedRowIds) &&
    expectedRowIds.includes(unavailableReviewRow) &&
    acceptedReviewBatchRows(rows)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Terminal Native checks are independent of the child review outcome. */
export function hasNativeSourcePostconditions(
  receipt: unknown,
  expected: {
    batch: "standard" | "express" | "extensibility";
    runnerSHA256: string;
    rowIds: readonly string[];
  },
): boolean {
  if (!isRecord(receipt) || !isRecord(receipt.rows)) {
    return false;
  }
  const proof = receipt.sourcePostconditions;
  const sourceRows = receipt.rows;
  const rowIds = Object.keys(sourceRows);
  return (
    expected.rowIds.length > 0 &&
    receipt.contract ===
      (expected.batch === "extensibility"
        ? "native-provider-extension-source/v1"
        : "native-connections-joined-source/v1") &&
    receipt.batch === expected.batch &&
    receipt.runnerSHA256 === expected.runnerSHA256 &&
    receipt.expectedInventoryRows === 53 &&
    receipt.batchRows === expected.rowIds.length &&
    rowIds.length === expected.rowIds.length &&
    new Set(expected.rowIds).size === expected.rowIds.length &&
    expected.rowIds.every((rowId) => Object.hasOwn(sourceRows, rowId)) &&
    isRecord(proof) &&
    Object.keys(proof).length === 2 &&
    proof.contract === "native-connections-source-postconditions/v1" &&
    proof.verified === true
  );
}

function isRowIdPart(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

/** Read Native's independent G0 oracle; do not infer expected IDs from results. */
export function baselineRowIds(inventory: unknown): readonly string[] {
  assert.ok(isRecord(inventory));
  assert.equal(inventory.schema, "native-parity-inventory/v1");
  assert.equal(inventory.sourceRepository, "agent-teams-ai/sub2api-standalone");
  assert.ok(Array.isArray(inventory.rows));
  const rowIds = inventory.rows.map((row: unknown) => {
    assert.ok(isRecord(row));
    const { profileId, methodId, credentialVariant } = row;
    assert.ok(isRowIdPart(profileId) && isRowIdPart(methodId) && isRowIdPart(credentialVariant));
    return `${profileId}/${methodId}/${credentialVariant}`;
  });
  assert.equal(rowIds.length, 53);
  assert.equal(new Set(rowIds).size, 53);
  return rowIds;
}
