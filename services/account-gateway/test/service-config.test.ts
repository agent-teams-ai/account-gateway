import test from 'node:test';
import assert from 'node:assert/strict';
import { captureServiceProfiles, ServiceError } from '../src/service-config.ts';

const serviceProfile = (requests: number) => ({ profile: 'openai-responses-apikey-v1', model: 'gpt-5.4-mini',
  baseURL: 'https://api.openai.com/v1', qualificationRef: 'qualification-a',
  limits: { requests, concurrency: 1, requestBytes: 1_048_576, outputBytes: 1_048_576, tokens: 32_768 },
  providerTokenUpperBound: 100_000 });
const denied = (body: () => unknown) =>
  assert.throws(body, e => e instanceof ServiceError && e.code === 'config_denied');

// Red if an approved multi-batch run budget is denied at startup and strands a large review after its first batches.
test('service profile admits an approved 640-request run budget and still denies above the bound', () => {
  const [profile] = captureServiceProfiles({ profile: serviceProfile(640) });
  assert.equal(profile.limits.requests, 640);
  denied(() => captureServiceProfiles({ profile: serviceProfile(641) }));
});
