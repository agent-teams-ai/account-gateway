import test from 'node:test';
import assert from 'node:assert/strict';
import { strictJSON, validateResponses } from '../src/facade-ingress.ts';
import { KernelError } from '../src/domain.ts';
const bytes = (text: string) => Buffer.from(text);
const valid = { model: 'fixture-model', stream: true, store: false, service_tier: 'default', input: 'fixture' };
const invalid = (fn: () => unknown) => assert.throws(fn, e => e instanceof KernelError && e.code === 'invalid');
test('decoded duplicate names, malformed UTF-8 and bounded nesting deny ingress', () => {
  invalid(() => strictJSON(bytes('{"model":"a","\\u006dodel":"b"}')));
  invalid(() => strictJSON(bytes('{"outer":{"key":1,"\\u006bey":2}}')));
  invalid(() => strictJSON(new Uint8Array([0x22, 0xff, 0x22])));
  invalid(() => strictJSON(bytes('['.repeat(66) + '0' + ']'.repeat(66))));
  assert.deepEqual(strictJSON(bytes('{"\\u006bey":1,"value":"literal \\\"key\\\""}')), { key: 1, value: 'literal "key"' });
});
test('Responses policy rejects critical aliases and unsafe provider options before transport', () => {
  for (const patch of [{ store: true }, { stream: false }, { service_tier: 'priority' }, { previous_response_id: 'old' },
    { model: 'unqualified' }, { MAX_OUTPUT_TOKENS: 20 }, { '\uff33tore': false }]) {
    invalid(() => validateResponses(bytes(JSON.stringify({ ...valid, ...patch })), ['fixture-model'], 100));
  }
});
test('output cap lexical precision cannot round a fractional or exponential authority into an integer', () => {
  for (const cap of ['1.000000000000000001', '1e1', '0', '-1', 'null', '"10"', '101']) {
    invalid(() => validateResponses(bytes(JSON.stringify(valid).slice(0, -1) + ',"max_output_tokens":' + cap + '}'), ['fixture-model'], 100));
  }
  validateResponses(bytes(JSON.stringify({ ...valid, max_output_tokens: 100 })), ['fixture-model'], 100);
});
test('qualified canonical escapes and unrelated tool text preserve original request bytes', () => {
  const raw = bytes('{"\\u006dodel":"fixture-model","stream":true,"store":false,"service_tier":"default","input":[{"content":"MAX_OUTPUT_TOKENS user text"}]}');
  const before = Buffer.from(raw);
  validateResponses(raw, ['fixture-model'], 100);
  assert.deepEqual(raw, before);
});

test('SDK control numeric tokens cannot round into an accepted integer authority', () => {
  for (const token of ['1.000000000000000001', '0.0000000000000000000000000000000000000000000000000001', '1e0', '-0', '9007199254740991.1']) {
    invalid(() => strictJSON(bytes('{"policyRevision":' + token + ',"limits":{"tokens":100}}'), true));
    invalid(() => strictJSON(bytes('{"limits":{"requestBytes":' + token + '}}'), true));
  }
  assert.deepEqual(strictJSON(bytes('{"policyRevision":0,"bindingRevision":9007199254740991,"limits":{"tokens":100}}'), true),
    { policyRevision: 0, bindingRevision: 9007199254740991, limits: { tokens: 100 } });
  // Opaque native request values retain ordinary JSON numeric semantics.
  const raw = bytes(JSON.stringify({ ...valid, temperature: 0.25, input: [{ user_value: 1.5 }] }));
  validateResponses(raw, ['fixture-model'], 100);
  assert.equal((strictJSON(raw) as { temperature: number }).temperature, 0.25);
});
