import assert from "node:assert/strict";

/** An observed capability restriction never substitutes for a completed review. */
export const unavailableReviewRow = "typesafe-systemone-apikey-v1/api_key/provider_api_key";

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

export function acceptedBaselineRows(
  rows: readonly AcceptanceRow[],
  expectedRowIds: readonly string[],
): boolean {
  const expected = new Set(expectedRowIds);
  return (
    expectedRowIds.length === 53 &&
    expected.size === 53 &&
    rows.length === 53 &&
    rows.every((row) => expected.has(row.rowId)) &&
    acceptedBatchRows(rows)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
