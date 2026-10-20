import test from 'node:test';
import assert from 'node:assert/strict';
import { captureServiceProfiles, ServiceError } from '../src/service-config.ts';

const serviceProfile = (requests: number) => ({ profile: 'openai-responses-apikey-v1', model: 'gpt-5.4-mini',
  baseURL: 'https://api.openai.com/v1', qualificationRef: 'qualification-a',
  limits: { requests, concurrency: 1, requestBytes: 1_048_576, outputBytes: 1_048_576, tokens: 32_768 },
  providerTokenUpperBound: 100_000 });
const denied = (body: () => unknown) =>
  assert.throws(body, e => e instanceof ServiceError && e.code === 'config_denied');

// Red if raising the run budget needs a code change again: the operational knob is the service
// profile, the code keeps only the acceptance ceiling.
test('service profile admits production budgets up to the code ceiling and denies above it', () => {
  const [prod] = captureServiceProfiles({ profile: serviceProfile(640) });
  assert.equal(prod.limits.requests, 640);
  const [ceiling] = captureServiceProfiles({ profile: serviceProfile(10_000) });
  assert.equal(ceiling.limits.requests, 10_000);
  denied(() => captureServiceProfiles({ profile: serviceProfile(10_001) }));
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
    modelScope: ['gpt-5.6-sol'] as const, qualificationRef: 'synthetic-codex',
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
