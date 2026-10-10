import { strictJSON } from './facade-ingress.ts';
import { object } from './native-wire.ts';

const phases = new Set(['transport', 'invalid_response', 'http_status', 'body_read', 'body_limit',
  'invalid_final', 'invalid_content_type', 'sse_frame_limit', 'sse_invalid_frame', 'sse_invalid_event',
  'sse_provider_failure', 'sse_incomplete', 'sse_read', 'deadline', 'downstream_write', 'downstream_flush']);

const providerErrorCategories = new Set([
  'empty_error_body', 'sse_error_body', 'html_error_body', 'unhandled_error_encoding',
  'body_read_failed', 'body_limit', 'invalid_error_json', 'code_mode_rejected',
  'authentication_rejected', 'model_rejected', 'parameter_service_tier',
  'parameter_max_output_tokens', 'parameter_parallel_tool_calls', 'parameter_context_management',
  'responses_lite_required', 'unsupported_parameter', 'invalid_request', 'unknown',
]);

// Private native stderr contract only. Reconstruct accepted fields so provider
// bodies, arbitrary native logger output and malformed records never escape.
export function nativeResponseDiagnostics(write: (record: string) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0), oversized = false;
  const accept = (line: Buffer) => {
    let record: string;
    try {
      const row = object(strictJSON(line, true), ['event', 'phase'], ['http_status', 'provider_error_category']);
      if (row.event !== 'gateway_native_response_failure' || typeof row.phase !== 'string' || !phases.has(row.phase)) return;
      const status = row.http_status;
      if (Object.hasOwn(row, 'http_status') && (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599)) return;
      const category = row.provider_error_category;
      if (Object.hasOwn(row, 'provider_error_category') && (typeof category !== 'string' || !providerErrorCategories.has(category))) return;
      record = JSON.stringify({ event: 'gateway_native_response_failure', phase: row.phase,
        ...(status === undefined ? {} : { http_status: status }),
        ...(category === undefined ? {} : { provider_error_category: category }) }) + '\n';
    } catch { return; }
    write(record);
  };
  return chunk => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      if (!oversized) {
        if (pending.length + end - start > 4096) { pending = Buffer.alloc(0); oversized = true; }
        else pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      }
      if (newline < 0) return;
      if (!oversized) accept(pending);
      pending = Buffer.alloc(0); oversized = false; start = newline + 1;
    }
  };
}
