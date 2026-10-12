import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeResponseDiagnostics } from '../src/native-response-diagnostics.ts';

const categorized = '{"event":"gateway_native_response_failure","phase":"http_status","http_status":400,"provider_error_category":"responses_lite_required"}';
const valid = '{"event":"gateway_native_response_failure","phase":"http_status","http_status":502}';
function sink() {
  const records: string[] = [];
  return { records, feed: nativeResponseDiagnostics(record => { records.push(record); }) };
}

// OAuth entry is spent on failure; the private operator needs its finite phase,
// while tokens, provider text and identity metadata must remain excluded.
test('native diagnostics retains closed OAuth phases and rejects private or misplaced fields', () => {
  const f = sink(), expected: string[] = [];
  const phases = ['exchange_transport', 'exchange_http_status', 'exchange_body_read',
    'exchange_body_limit', 'exchange_json_shape', 'exchange_token_fields', 'exchange_scopes',
    'exchange_bundle', 'stage_metadata', 'stage_identity', 'stage_custody', 'stage_conflict', 'stage_repository'];
  for (const phase of phases) {
    const record = JSON.stringify({ event: 'gateway_native_oauth_connect_failure', phase,
      ...(phase === 'exchange_http_status' ? { http_status: 401 } : {}) });
    for (const byte of Buffer.from(record + '\n')) f.feed(Buffer.from([byte]));
    expected.push(record + '\n');
    for (const key of ['message', 'token', 'account_ref', 'url', 'provider_error_category']) {
      f.feed(Buffer.from(record.replace('}', ',"' + key + '":"SECRET_SENTINEL"}') + '\n'));
    }
    f.feed(Buffer.from(record.replace('}', ',"phase":"stage_identity"}') + '\n'));
  }
  for (const record of [
    '{"event":"gateway_native_oauth_connect_failure","phase":"unknown"}',
    '{"event":"gateway_native_oauth_connect_failure","phase":"exchange_transport","http_status":200}',
    '{"event":"gateway_native_oauth_connect_failure","phase":"exchange_http_status"}',
    ...['99', '600', '401.0', '"401"', 'null'].map(status =>
      '{"event":"gateway_native_oauth_connect_failure","phase":"exchange_http_status","http_status":' + status + '}'),
    '{"event":"gateway_native_oauth_connect_failure","phase":"stage_identity","\\u0070hase":"stage_custody"}',
  ]) f.feed(Buffer.from(record + '\n'));
  f.feed(Buffer.from(valid + '\n'));
  expected.push(valid + '\n');
  assert.deepEqual(f.records, expected);
});

// Previously all native stderr records were discarded, hiding response failures.
test('native response diagnostics forwards chunked records once in canonical form', () => {
  const f = sink();
  const bytes = Buffer.from(' {"http_status":502,"phase":"http_status","event":"gateway_native_response_failure"}\n');
  for (const byte of bytes) f.feed(Buffer.from([byte]));
  f.feed(Buffer.from('{"event":"gateway_native_response_failure","phase":"transport"}\n'));
  for (const byte of Buffer.from(categorized + '\n')) f.feed(Buffer.from([byte]));
  assert.deepEqual(f.records, [valid + '\n', '{"event":"gateway_native_response_failure","phase":"transport"}\n', categorized + '\n']);
});

// Native non-JSON failure diagnostics must survive arbitrary pipe chunking
// without admitting private payload fields or extending the category vocabulary.
test('native response diagnostics retains finite error body categories and rejects private extensions', () => {
  const f = sink();
  const categories = ['empty_error_body', 'sse_error_body', 'html_error_body', 'unhandled_error_encoding'];
  const expected: string[] = [];
  for (const category of categories) {
    const record = '{"event":"gateway_native_response_failure","phase":"http_status","http_status":400,"provider_error_category":"' + category + '"}';
    for (const byte of Buffer.from(record + '\n')) f.feed(Buffer.from([byte]));
    expected.push(record + '\n');
    f.feed(Buffer.from(record.replace('}', ',"body":"SECRET_SENTINEL"}') + '\n'));
    f.feed(Buffer.from(record.replace('}', ',"provider_error_category":"unknown"}') + '\n'));
  }
  f.feed(Buffer.from(categorized.replace('responses_lite_required', 'sse_error_body_SECRET_SENTINEL') + '\n'));
  assert.deepEqual(f.records, expected);
});

// The private projection must retain closed structural facts without changing
// the semantic category or revealing provider event names and parameter paths.
test('native response diagnostics retains optional finite error shapes and parameter families', () => {
  const f = sink();
  const expected: string[] = [];
  const shapes = ['root_error_object', 'response_error_object', 'flat_error_object',
    'non_object', 'unrecognized_object', 'ambiguous'];
  for (const shape of shapes) {
    const record = categorized.replace('responses_lite_required', 'unknown')
      .replace('}', ',"provider_error_shape":"' + shape + '"}');
    for (const byte of Buffer.from(record + '\n')) f.feed(Buffer.from([byte]));
    expected.push(record + '\n');
  }
  const parameters = ['service_tier', 'max_output_tokens', 'parallel_tool_calls', 'context_management',
    'tools', 'input', 'reasoning', 'model', 'store', 'instructions', 'stream', 'text',
    'tool_choice', 'truncation', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_retention',
    'include', 'metadata', 'background', 'temperature', 'top_p', 'missing', 'other'];
  for (const parameter of parameters) {
    const suffix = ',"provider_error_shape":"response_error_object","provider_error_parameter":"' + parameter + '"}';
    const record = categorized.replace('}', suffix);
    const reordered = '{"provider_error_parameter":"' + parameter + '","provider_error_shape":"response_error_object",'
      + categorized.slice(1);
    for (const byte of Buffer.from(reordered + '\n')) f.feed(Buffer.from([byte]));
    expected.push(record + '\n');
  }
  f.feed(Buffer.from(valid + '\n' + categorized + '\n'));
  expected.push(valid + '\n', categorized + '\n');
  assert.deepEqual(f.records, expected);
});

test('native response diagnostics drops private or ambiguous structural projections and resumes', () => {
  const f = sink();
  const projected = categorized.replace('}', ',"provider_error_shape":"root_error_object","provider_error_parameter":"tools"}');
  const unsafe = [
    ...['provider_error_shape', 'provider_error_parameter'].flatMap(key =>
      ['"SECRET_SENTINEL"', 'null', '1', 'true', '{}', '[]'].map(value =>
        categorized.replace('}', ',"' + key + '":' + value + '}'))),
    projected.replace('root_error_object', 'root_error_object_SECRET_SENTINEL'),
    projected.replace('"tools"', '"tools[0].SECRET_SENTINEL"'),
    projected.replace('}', ',"provider_error_shape":"flat_error_object"}'),
    projected.replace('}', ',"provider_error_parameter":"other"}'),
    projected.replace('}', ',"\\u0070rovider_error_shape":"flat_error_object"}'),
    projected.replace('}', ',"\\u0070rovider_error_parameter":"other"}'),
    ...['body', 'message', 'event_name', 'parameter_path', 'Provider_Error_Shape', 'Provider_Error_Parameter'].map(key =>
      projected.replace('}', ',"' + key + '":"SECRET_SENTINEL"}')),
  ];
  for (const line of unsafe) f.feed(Buffer.from(line + '\n'));
  f.feed(Buffer.from(projected + '\n'));
  assert.deepEqual(f.records, [projected + '\n']);
});

// Red if arbitrary native stderr, secret fields, ambiguous JSON or unsupported
// phases cross the operator log boundary, even beside a legitimate record.
test('native response diagnostics discards unsafe records and resumes at newline', () => {
  const f = sink();
  const unsafe = [
    'Authorization: Bearer SECRET_SENTINEL',
    '{"state":"ready","binding":{}}',
    'null', '[]', '{}',
    valid.replace('http_status', 'unknown_phase'),
    valid.replace('gateway_native_response_failure', 'other_event'),
    valid.replace('502', '99'), valid.replace('502', '600'),
    valid.replace('502', '502.0'), valid.replace('502', '5.02e2'),
    valid.replace('502', '"502"'), valid.replace('502', 'null'),
    valid.replace('502', '9007199254740993'),
    valid.replace('}', ',"phase":"body_read"}'),
    valid.replace('}', ',"\\u0070hase":"body_read"}'),
    ...['body', 'url', 'authorization', '__proto__', 'constructor', 'prototype'].map(key =>
      valid.replace('}', ',"' + key + '":"SECRET_SENTINEL"}')),
    '{"event":"gateway_native_response_failure","phase":"transport"',
    ...['"SECRET_SENTINEL"', 'null', '1', '{}', '[]'].map(value =>
      valid.replace('}', ',"provider_error_category":' + value + '}')),
    categorized.replace('}', ',"provider_error_category":"unknown"}'),
    categorized.replace('}', ',"body":"SECRET_SENTINEL"}'),
    'x'.repeat(4097),
  ];
  for (const line of unsafe) f.feed(Buffer.from(line + '\n'));
  f.feed(Buffer.from(valid + '\n'));
  assert.deepEqual(f.records, [valid + '\n']);
});

test('native response diagnostics drops oversized and unfinished chunked lines', () => {
  const f = sink();
  f.feed(Buffer.alloc(4096, 120));
  f.feed(Buffer.from('x' + valid));
  f.feed(Buffer.from('\n' + valid + '\n' + valid));
  assert.deepEqual(f.records, [valid + '\n']);
});

// Red if the private decoder drops the new native read reason or accepts it
// outside sse_read, where it would misrepresent a deadline or another failure.
test('native response diagnostics retains chunked closed SSE read reasons and legacy records', () => {
  const f = sink();
  const legacy = '{"event":"gateway_native_response_failure","phase":"sse_read","http_status":200}';
  const expected = [legacy + '\n'];
  f.feed(Buffer.from(legacy + '\n'));
  for (const reason of ['idle_expired', 'context_canceled', 'context_deadline', 'unexpected_eof',
    'body_after_close', 'connection_closed', 'transport_timeout', 'compression_error', 'other']) {
    const canonical = legacy.replace('}', ',"read_error_reason":"' + reason + '"}');
    const reordered = '{"read_error_reason":"' + reason + '","http_status":200,"phase":"sse_read","event":"gateway_native_response_failure"}';
    for (const byte of Buffer.from(reordered + '\n')) f.feed(Buffer.from([byte]));
    expected.push(canonical + '\n');
  }
  assert.deepEqual(f.records, expected);
});

test('native response diagnostics rejects malformed or misplaced SSE read reasons and resumes', () => {
  const f = sink();
  const record = '{"event":"gateway_native_response_failure","phase":"sse_read","http_status":200,"read_error_reason":"idle_expired"}';
  const unsafe = [
    ...['"unknown"', '"idle_expired_SECRET_SENTINEL"', 'null', '1', 'true', '{}', '[]'].map(value =>
      record.replace('"idle_expired"', value)),
    ...['deadline', 'body_read', 'body_limit', 'sse_frame_limit', 'transport'].map(phase => record.replace('sse_read', phase)),
    record.replace('}', ',"read_error_reason":"other"}'),
    record.replace('}', ',"\\u0072ead_error_reason":"other"}'),
    record.replace('}', ',"body":"SECRET_SENTINEL"}'),
    record.replace('read_error_reason', 'Read_Error_Reason'),
  ];
  for (const line of unsafe) f.feed(Buffer.from(line + '\n'));
  f.feed(Buffer.from(record + '\n' + valid + '\n'));
  assert.deepEqual(f.records, [record + '\n', valid + '\n']);
});

// Red if the real native media classification is lost at the private pipe
// boundary, or existing records become dependent on the optional addition.
test('native response diagnostics retains closed media categories through split bytes and legacy records', () => {
  const f = sink();
  const legacy = '{"event":"gateway_native_response_failure","phase":"invalid_content_type","http_status":200}';
  const expected = [legacy + '\n'];
  f.feed(Buffer.from(legacy + '\n'));
  for (const category of ['missing', 'json', 'html', 'sse', 'other']) {
    const record = legacy.replace('}', ',"upstream_media_category":"' + category + '"}');
    const reordered = '{"upstream_media_category":"' + category + '","http_status":200,"phase":"invalid_content_type","event":"gateway_native_response_failure"}';
    for (const byte of Buffer.from(reordered + '\n')) f.feed(Buffer.from([byte]));
    expected.push(record + '\n');
  }
  const jsonError = legacy.replace('}', ',"provider_error_category":"model_rejected","provider_error_shape":"flat_error_object","provider_error_parameter":"model","upstream_media_category":"json"}');
  for (const byte of Buffer.from(jsonError + '\n')) f.feed(Buffer.from([byte]));
  expected.push(jsonError + '\n');
  assert.deepEqual(f.records, expected);
});

test('native response diagnostics rejects raw, malformed, duplicate or misplaced media and resumes', () => {
  const f = sink();
  const record = '{"event":"gateway_native_response_failure","phase":"invalid_content_type","http_status":200,"upstream_media_category":"html"}';
  const unsafe = [
    ...['"text/html; SECRET_SENTINEL"', '"html_SECRET_SENTINEL"', '"unknown"', 'null', '1', 'true', '{}', '[]'].map(value => record.replace('"html"', value)),
    ...['http_status', 'deadline', 'sse_read', 'transport', 'body_read'].map(phase => record.replace('invalid_content_type', phase)),
    record.replace('gateway_native_response_failure', 'gateway_native_oauth_connect_failure'),
    record.replace('gateway_native_response_failure', 'gateway_native_codex_request_shape'),
    record.replace('}', ',"upstream_media_category":"other"}'),
    record.replace('}', ',"\\u0075pstream_media_category":"other"}'),
    ...['body', 'content_type', 'url', 'token'].map(key => record.replace('}', ',"' + key + '":"SECRET_SENTINEL"}')),
  ];
  for (const line of unsafe) f.feed(Buffer.from(line + '\n'));
  f.feed(Buffer.from(record + '\n' + valid + '\n'));
  assert.deepEqual(f.records, [record + '\n', valid + '\n']);
});

// Missing-media body observations are finite diagnostics; every record still
// describes a rejected response and must not leak the inspected body.
test('native response diagnostics retains body shapes only for missing media and rejects private extensions', () => {
  const f = sink(), expected: string[] = [];
  const missing = '{"event":"gateway_native_response_failure","phase":"invalid_content_type","http_status":200,"upstream_media_category":"missing"}';
  for (const shape of ['empty', 'json', 'sse', 'html', 'other']) {
    const record = missing.replace('}', ',"upstream_body_shape":"' + shape + '"}');
    for (const byte of Buffer.from(record + '\n')) f.feed(Buffer.from([byte]));
    expected.push(record + '\n');
  }
  const jsonError = missing.replace(',"upstream_media_category":"missing"}', ',"provider_error_category":"authentication_rejected","provider_error_shape":"flat_error_object","provider_error_parameter":"missing","upstream_media_category":"missing","upstream_body_shape":"json"}');
  f.feed(Buffer.from(jsonError + '\n'));
  expected.push(jsonError + '\n');
  const record = missing.replace('}', ',"upstream_body_shape":"other"}');
  const unsafe = [
    ...['"SECRET_SENTINEL"', 'null', '1', 'true', '{}', '[]'].map(value => record.replace('"upstream_body_shape":"other"', '"upstream_body_shape":' + value)),
    record.replace('invalid_content_type', 'http_status'),
    record.replace('gateway_native_response_failure', 'gateway_native_oauth_connect_failure'),
    record.replace('gateway_native_response_failure', 'gateway_native_codex_request_shape'),
    ...['json', 'html', 'sse', 'other'].map(media => record.replace('"upstream_media_category":"missing"', '"upstream_media_category":"' + media + '"')),
    record.replace(',"upstream_media_category":"missing"', ''),
    record.replace('}', ',"upstream_body_shape":"html"}'),
    record.replace('}', ',"\\u0075pstream_body_shape":"html"}'),
    ...['body', 'message', 'url', 'token'].map(key => record.replace('}', ',"' + key + '":"SECRET_SENTINEL"}')),
  ];
  for (const line of unsafe) f.feed(Buffer.from(line + '\n'));
  f.feed(Buffer.from(missing + '\n' + valid + '\n'));
  expected.push(missing + '\n', valid + '\n');
  assert.deepEqual(f.records, expected);
});

// Matches the actual protected native HTTP400 emission, through pipe chunking.
test('native private Codex request shape reaches operator sink with scalar facts only', () => {
  const f = sink();
  const fields = ['max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p',
    'frequency_penalty', 'presence_penalty', 'chat_template_kwargs', 'user', 'metadata',
    'prompt_cache_retention', 'safety_identifier', 'stream_options', 'truncation', 'stop_sequences'];
  const row = { event: 'gateway_native_codex_request_shape', canonical_object: true,
    instructions_present: false, instructions_string: false, instructions_nonblank: false,
    unsupported_fields_present: Object.fromEntries(fields.map(key => [key, false])) };
  const record = JSON.stringify(row);
  for (const byte of Buffer.from(record + '\n')) f.feed(Buffer.from([byte]));
  for (const key of ['body', 'message', 'token', 'account_ref', 'model']) {
    f.feed(Buffer.from(JSON.stringify({ ...row, [key]: 'SECRET_SENTINEL' }) + '\n'));
    f.feed(Buffer.from(JSON.stringify({ ...row, unsupported_fields_present: { ...row.unsupported_fields_present, [key]: 'SECRET_SENTINEL' } }) + '\n'));
  }
  f.feed(Buffer.from(JSON.stringify({ ...row, instructions_present: 'SECRET_SENTINEL' }) + '\n'));
  f.feed(Buffer.from(JSON.stringify({ ...row, instructions_nonblank: true }) + '\n'));
  f.feed(Buffer.from(record.replace('"canonical_object":true', '"canonical_object":true,"canonical_object":false') + '\n'));
  f.feed(Buffer.from(record.replace('"metadata":false', '"metadata":false,"metadata":true') + '\n'));
  f.feed(Buffer.from(valid + '\n'));
  assert.deepEqual(f.records, [record + '\n', valid + '\n']);
});
