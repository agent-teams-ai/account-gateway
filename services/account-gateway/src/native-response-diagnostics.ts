import { strictJSON } from "./facade-ingress.ts";
import { object } from "./native-wire.ts";
import { identifier, uuid } from "./domain.ts";

const phases = new Set([
  "transport",
  "invalid_response",
  "http_status",
  "body_read",
  "body_limit",
  "invalid_final",
  "invalid_content_type",
  "sse_frame_limit",
  "sse_invalid_frame",
  "sse_invalid_event",
  "sse_provider_failure",
  "sse_incomplete",
  "sse_read",
  "deadline",
  "downstream_write",
  "downstream_flush",
]);

const oauthPhases = new Set([
  "exchange_transport",
  "exchange_http_status",
  "exchange_body_read",
  "exchange_body_limit",
  "exchange_json_shape",
  "exchange_token_fields",
  "exchange_scopes",
  "exchange_bundle",
  "stage_metadata",
  "stage_identity",
  "stage_custody",
  "stage_conflict",
  "stage_repository",
]);
const oauthConflictReasons = new Set([
  "connect_scope_mismatch",
  "connect_binding_read_failed",
  "connect_binding_mismatch",
  "principal_claim_scope_mismatch",
  "logical_claim_conflict",
  "reservation_readback_failed",
  "reservation_commitment_mismatch",
  "replay_mismatch",
  "unclassified",
]);
const oauthIntentFields = ["consumer", "account_ref", "generation", "operation_ref"];

const readErrorReasons = new Set([
  "idle_expired",
  "context_canceled",
  "context_deadline",
  "unexpected_eof",
  "body_after_close",
  "connection_closed",
  "transport_timeout",
  "compression_error",
  "other",
]);
const upstreamMediaCategories = new Set(["missing", "json", "html", "sse", "other"]);
const upstreamBodyShapes = new Set(["empty", "json", "sse", "html", "other"]);
const upstreamBodyPrefixes = new Set([
  "json_prefix",
  "sse_prefix",
  "html_prefix",
  "gzip_prefix",
  "zstd_prefix",
  "binary",
  "text",
  "empty",
]);

const providerErrorCategories = new Set([
  "empty_error_body",
  "sse_error_body",
  "html_error_body",
  "unhandled_error_encoding",
  "body_read_failed",
  "body_limit",
  "invalid_error_json",
  "code_mode_rejected",
  "authentication_rejected",
  "model_rejected",
  "parameter_service_tier",
  "parameter_max_output_tokens",
  "parameter_parallel_tool_calls",
  "parameter_context_management",
  "responses_lite_required",
  "unsupported_parameter",
  "invalid_request",
  "unknown",
]);

const providerErrorShapes = new Set([
  "root_error_object",
  "response_error_object",
  "flat_error_object",
  "non_object",
  "unrecognized_object",
  "ambiguous",
]);
const providerErrorParameters = new Set([
  "service_tier",
  "max_output_tokens",
  "parallel_tool_calls",
  "context_management",
  "tools",
  "input",
  "reasoning",
  "model",
  "store",
  "instructions",
  "stream",
  "text",
  "tool_choice",
  "truncation",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "include",
  "metadata",
  "background",
  "temperature",
  "top_p",
  "missing",
  "other",
]);

const unsupportedCodexFields = [
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "chat_template_kwargs",
  "user",
  "metadata",
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
  "truncation",
  "stop_sequences",
];
const shapeFields = [
  "canonical_object",
  "instructions_present",
  "instructions_string",
  "instructions_nonblank",
];

// Private native stderr contract only. Reconstruct accepted fields so provider
// bodies, arbitrary native logger output and malformed records never escape.
export function nativeResponseDiagnostics(
  write: (record: string) => void,
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0),
    oversized = false;
  const accept = (line: Buffer) => {
    let record: string;
    try {
      const row = object(
        strictJSON(line, true),
        ["event"],
        [
          "phase",
          "http_status",
          "reason",
          ...oauthIntentFields,
          "provider_error_category",
          "provider_error_shape",
          "provider_error_parameter",
          "read_error_reason",
          "upstream_media_category",
          "upstream_body_shape",
          "upstream_body_prefix",
          ...shapeFields,
          "unsupported_fields_present",
        ],
      );
      if (row.event === "gateway_native_codex_request_shape") {
        object(row, ["event", ...shapeFields, "unsupported_fields_present"]);
        const fields = object(row.unsupported_fields_present, unsupportedCodexFields);
        if (
          ![
            ...shapeFields.map((key) => row[key]),
            ...unsupportedCodexFields.map((key) => fields[key]),
          ].every((value) => typeof value === "boolean")
        )
          return;
        if (
          (row.instructions_nonblank && !row.instructions_string) ||
          (row.instructions_string && !row.instructions_present)
        )
          return;
        if (
          !row.canonical_object &&
          [
            ...shapeFields.slice(1).map((key) => row[key]),
            ...unsupportedCodexFields.map((key) => fields[key]),
          ].some(Boolean)
        )
          return;
        record =
          JSON.stringify({
            event: "gateway_native_codex_request_shape",
            canonical_object: row.canonical_object,
            instructions_present: row.instructions_present,
            instructions_string: row.instructions_string,
            instructions_nonblank: row.instructions_nonblank,
            unsupported_fields_present: Object.fromEntries(
              unsupportedCodexFields.map((key) => [key, fields[key]]),
            ),
          }) + "\n";
      } else {
        object(
          row,
          ["event", "phase"],
          [
            "http_status",
            "reason",
            ...oauthIntentFields,
            "provider_error_category",
            "provider_error_shape",
            "provider_error_parameter",
            "read_error_reason",
            "upstream_media_category",
            "upstream_body_shape",
            "upstream_body_prefix",
          ],
        );
        if (row.event === "gateway_native_oauth_connect_failure") {
          object(row, ["event", "phase"], ["http_status", "reason", ...oauthIntentFields]);
          if (typeof row.phase !== "string" || !oauthPhases.has(row.phase)) return;
          const status = row.http_status;
          if (row.phase === "exchange_http_status") {
            if (
              !Number.isSafeInteger(status) ||
              (status as number) < 100 ||
              (status as number) > 599
            )
              return;
          } else if (Object.hasOwn(row, "http_status")) return;
          const reason = row.reason;
          if (
            Object.hasOwn(row, "reason") &&
            (row.phase !== "stage_conflict" ||
              typeof reason !== "string" ||
              !oauthConflictReasons.has(reason))
          )
            return;
          let intent: object = {};
          if (oauthIntentFields.some((key) => Object.hasOwn(row, key))) {
            identifier(row.consumer);
            uuid(row.account_ref);
            uuid(row.generation);
            identifier(row.operation_ref);
            intent = {
              consumer: row.consumer,
              account_ref: row.account_ref,
              generation: row.generation,
              operation_ref: row.operation_ref,
            };
          }
          record =
            JSON.stringify({
              event: "gateway_native_oauth_connect_failure",
              phase: row.phase,
              ...(reason === undefined ? {} : { reason }),
              ...(status === undefined ? {} : { http_status: status }),
              ...intent,
            }) + "\n";
        } else {
          object(
            row,
            ["event", "phase"],
            [
              "http_status",
              "provider_error_category",
              "provider_error_shape",
              "provider_error_parameter",
              "read_error_reason",
              "upstream_media_category",
              "upstream_body_shape",
              "upstream_body_prefix",
            ],
          );
          if (
            row.event !== "gateway_native_response_failure" ||
            typeof row.phase !== "string" ||
            !phases.has(row.phase)
          )
            return;
          const status = row.http_status;
          if (
            Object.hasOwn(row, "http_status") &&
            (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599)
          )
            return;
          const category = row.provider_error_category;
          if (
            Object.hasOwn(row, "provider_error_category") &&
            (typeof category !== "string" || !providerErrorCategories.has(category))
          )
            return;
          const shape = row.provider_error_shape;
          if (
            Object.hasOwn(row, "provider_error_shape") &&
            (typeof shape !== "string" || !providerErrorShapes.has(shape))
          )
            return;
          const parameter = row.provider_error_parameter;
          if (
            Object.hasOwn(row, "provider_error_parameter") &&
            (typeof parameter !== "string" || !providerErrorParameters.has(parameter))
          )
            return;
          const readReason = row.read_error_reason;
          if (
            Object.hasOwn(row, "read_error_reason") &&
            (row.phase !== "sse_read" ||
              typeof readReason !== "string" ||
              !readErrorReasons.has(readReason))
          )
            return;
          const mediaCategory = row.upstream_media_category;
          if (
            Object.hasOwn(row, "upstream_media_category") &&
            (row.phase !== "invalid_content_type" ||
              typeof mediaCategory !== "string" ||
              !upstreamMediaCategories.has(mediaCategory))
          )
            return;
          const bodyShape = row.upstream_body_shape;
          if (
            Object.hasOwn(row, "upstream_body_shape") &&
            (row.phase !== "invalid_content_type" ||
              mediaCategory !== "missing" ||
              typeof bodyShape !== "string" ||
              !upstreamBodyShapes.has(bodyShape))
          )
            return;
          const bodyPrefix = row.upstream_body_prefix;
          if (
            Object.hasOwn(row, "upstream_body_prefix") &&
            (row.phase !== "invalid_content_type" ||
              mediaCategory !== "missing" ||
              typeof bodyPrefix !== "string" ||
              !upstreamBodyPrefixes.has(bodyPrefix))
          )
            return;
          record =
            JSON.stringify({
              event: "gateway_native_response_failure",
              phase: row.phase,
              ...(status === undefined ? {} : { http_status: status }),
              ...(category === undefined ? {} : { provider_error_category: category }),
              ...(shape === undefined ? {} : { provider_error_shape: shape }),
              ...(parameter === undefined ? {} : { provider_error_parameter: parameter }),
              ...(readReason === undefined ? {} : { read_error_reason: readReason }),
              ...(mediaCategory === undefined ? {} : { upstream_media_category: mediaCategory }),
              ...(bodyShape === undefined ? {} : { upstream_body_shape: bodyShape }),
              ...(bodyPrefix === undefined ? {} : { upstream_body_prefix: bodyPrefix }),
            }) + "\n";
        }
      }
    } catch {
      return;
    }
    write(record);
  };
  return (chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start),
        end = newline < 0 ? chunk.length : newline;
      if (!oversized) {
        if (pending.length + end - start > 4096) {
          pending = Buffer.alloc(0);
          oversized = true;
        } else pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      }
      if (newline < 0) return;
      if (!oversized) accept(pending);
      pending = Buffer.alloc(0);
      oversized = false;
      start = newline + 1;
    }
  };
}
