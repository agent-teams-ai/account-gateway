import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedConfig, defaults, KernelError } from '../src/domain.ts';
import { captureServiceProfiles } from '../src/service-config.ts';

// Red if invalid runtime config can widen admission or create unbounded leases.
test('bounds reject zero, fractions, nonfinite values and independent hard ceilings', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 86_400_001]) {
    assert.throws(() => boundedConfig({ ...defaults, maxRunMs: value }), KernelError);
  }
  assert.throws(() => boundedConfig({ ...defaults, extra: 1 } as typeof defaults), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, cleanupLeaseMs: 300_001 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxRequests: 300, maxConcurrent: 129 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxRequests: 32, maxConcurrent: 33 }), KernelError);
  assert.equal(boundedConfig({ ...defaults, maxRequests: 300, maxConcurrent: 128 }).maxConcurrent, 128);
  assert.throws(() => boundedConfig({ ...defaults, maintenanceBatch: 1_001 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxRequestBytes: 16_777_217 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxOutputBytes: NaN }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxTokens: 1.5 }), KernelError);
  assert.equal(boundedConfig({ ...defaults, maxRequests: 2, maxConcurrent: 2 }).maxConcurrent, 2);
});
// Red if later caller mutation can change limits after kernel construction.
test('configured bounds are a frozen value copy', () => {
  const input = { ...defaults };
  const copy = boundedConfig(input);
  input.maxRequests = 999;
  assert.equal(copy.maxRequests, defaults.maxRequests);
  assert.equal(Object.isFrozen(copy), true);
});

// Red if the canonical configuration parser still rejects the native raw-SSE
// ceiling, or if widening total response bytes also widens unrelated limits.
test('qualified Codex profile admits eight MiB raw SSE and rejects one byte above', () => {
  const limits = { requests: 1, concurrency: 1, requestBytes: 1_048_576,
    outputBytes: 1_048_576, tokens: 32_768 };
  const profile = { profile: 'openai-responses-apikey-v1', model: 'mimo-v2-pro',
    baseURL: 'https://api.xiaomimimo.com/v1', qualificationRef: 'synthetic-mimo',
    limits, providerTokenUpperBound: 32_768 };
  const oauthEnrollment = { enabled: true as const, profile: 'openai-codex-oauth-responses-v1' as const,
    modelScope: ['gpt-5.6-sol'], qualificationRef: 'synthetic-codex',
    limits: { ...limits, outputBytes: 8_388_608 }, providerTokenUpperBound: 32_768 };
  const captured = captureServiceProfiles({ profile, oauthEnrollment });
  assert.deepEqual(captured[1].limits, { ...limits, outputBytes: 8_388_608 });
  assert.deepEqual(captured[0].limits, limits);
  assert.throws(() => captureServiceProfiles({ profile, oauthEnrollment: {
    ...oauthEnrollment, limits: { ...oauthEnrollment.limits, outputBytes: 8_388_609 },
  } }));
  assert.throws(() => captureServiceProfiles({ profile, oauthEnrollment: {
    ...oauthEnrollment, limits: { ...oauthEnrollment.limits, requestBytes: 1_048_577 },
  } }));
});
