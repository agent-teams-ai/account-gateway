import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeResponseDiagnostics } from '../src/native-response-diagnostics.ts';

const categorized = '{"event":"gateway_native_response_failure","phase":"http_status","http_status":400,"provider_error_category":"responses_lite_required"}';
const valid = '{"event":"gateway_native_response_failure","phase":"http_status","http_status":502}';
function sink() {
  const records: string[] = [];
  return { records, feed: nativeResponseDiagnostics(record => { records.push(record); }) };
}

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
