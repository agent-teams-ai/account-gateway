/** Accepted review scope: TypeSafe is discovered but unavailable for review. */
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
  return rows.every((row) => row.outcome === "passed" || isExpectedUnavailableReview(row));
}

export function acceptedBaselineRows(rows: readonly AcceptanceRow[]): boolean {
  return (
    rows.length === 53 &&
    new Set(rows.map((row) => row.rowId)).size === 53 &&
    rows.filter(isExpectedUnavailableReview).length === 1 &&
    rows.filter((row) => row.outcome === "passed" && row.enrolled && row.review === "passed")
      .length === 52
  );
}
