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
