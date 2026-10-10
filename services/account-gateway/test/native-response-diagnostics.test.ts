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
