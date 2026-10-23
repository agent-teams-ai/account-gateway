import test from 'node:test';
import assert from 'node:assert/strict';
import { captureServiceBearers, captureServiceProfiles, captureRequestReadbackRetention, ServiceError } from '../src/service-config.ts';

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

test('explicit qualified concurrency stays within each selected profile and never changes the default', () => {
  const base = serviceProfile(640);
  assert.equal(captureServiceProfiles({ profile: base })[0].limits.concurrency, 1);
  const qualified = captureServiceProfiles({ profile: { ...base, limits: { ...base.limits, concurrency: 64 } } });
  assert.equal(qualified[0].limits.concurrency, 64);
  denied(() => captureServiceProfiles({ profile: { ...base, limits: { ...base.limits, concurrency: 65 } } }));
  const grant = { role: 'consumer-control' as const, token: 'synthetic-concurrency-control', consumerId: 'fixture-consumer',
    profileIds: [base.profile], limits: { ...base.limits, concurrency: 32 }, maxRunMs: 60_000 };
  assert.equal(captureServiceBearers([grant], grant.consumerId, qualified)[0].role, 'consumer-control');
  denied(() => captureServiceBearers([grant], grant.consumerId, [base]));
  denied(() => captureServiceBearers([{ ...grant, limits: { ...grant.limits, concurrency: 65 } }], grant.consumerId, qualified));
});

test('request readback retention requires an explicit positive bounded duration', () => {
  assert.equal(captureRequestReadbackRetention(1), 1);
  assert.equal(captureRequestReadbackRetention(31_536_000_000), 31_536_000_000);
  for (const value of [undefined, null, 0, -1, 1.5, '60000', NaN, Infinity, 31_536_000_001])
    denied(() => captureRequestReadbackRetention(value));
});

// Red if configuration intersects output across profiles instead of capturing
// the selected envelope, or grants borrow an unselected profile's authority.
test('consumer output envelope uses only selected profiles and preserves all other grant bounds', () => {
  const profiles = [serviceProfile(640), { ...serviceProfile(640), profile: 'other-profile',
    limits: { ...serviceProfile(640).limits, outputBytes: 8_388_608 } }];
  const control = { role: 'consumer-control' as const, token: 'synthetic-consumer-control', consumerId: 'fixture-consumer',
    profileIds: profiles.map(p => p.profile), limits: { ...profiles[0].limits, outputBytes: 8_388_608 }, maxRunMs: 21_600_000 };
  const capture = (value: unknown) => captureServiceBearers([value], control.consumerId, profiles);
  assert.deepEqual(capture(control), [control]);
  denied(() => capture({ ...control, profileIds: [profiles[0].profile] }));
  denied(() => capture({ ...control, profileIds: [...control.profileIds, 'missing'] }));
  denied(() => capture({ ...control, limits: { ...control.limits, outputBytes: 8_388_609 } }));
  for (const field of ['requests', 'concurrency', 'requestBytes', 'tokens'] as const)
    denied(() => capture({ ...control, limits: { ...control.limits, [field]: control.limits[field] + 1 } }));
  denied(() => capture({ ...control, role: 'run-control', ownerRefs: ['fixture-owner'] }));
  denied(() => capture({ role: 'management', token: control.token, consumerId: control.consumerId, ownerRefs: ['fixture-owner'],
    preparation: { accountRefs: [], subjectRef: 'fixture-subject', policyRevision: 1, bindingRevision: 1,
      profileId: profiles[0].profile, limits: control.limits, maxRunMs: 60_000 } }));
  assert.deepEqual(capture({ ...control, limits: profiles[0].limits, maxRunMs: 1 }),
    [{ ...control, limits: profiles[0].limits, maxRunMs: 1 }]);
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

// The independent opt-in must not borrow Codex qualification or accept caller endpoints.
test('Claude enrollment captures only the fixed qualified tuple alongside Codex', () => {
  const profile = serviceProfile(4);
  const claudeOAuthEnrollment = { enabled: true as const, profile: 'anthropic-claude-oauth-messages-v1' as const,
    modelScope: ['claude-sonnet-4-6'] as const, qualificationRef: 'synthetic-claude', limits: profile.limits, providerTokenUpperBound: 65536 };
  const oauthEnrollment = { enabled: true as const, profile: 'openai-codex-oauth-responses-v1' as const,
    modelScope: ['gpt-5.6-sol'] as const, qualificationRef: 'synthetic-codex', limits: profile.limits, providerTokenUpperBound: 65536 };
  const profiles = captureServiceProfiles({ profile, oauthEnrollment, claudeOAuthEnrollment });
  assert.deepEqual(profiles.map(p => [p.profile, p.model, p.qualificationRef]), [
    ['openai-responses-apikey-v1', 'gpt-5.4-mini', 'qualification-a'],
    ['openai-codex-oauth-responses-v1', 'gpt-5.6-sol', 'synthetic-codex'],
    ['anthropic-claude-oauth-messages-v1', 'claude-sonnet-4-6', 'synthetic-claude'],
  ]);
  for (const patch of [{ profile: oauthEnrollment.profile }, { modelScope: ['other'] }, { baseURL: 'https://fixture.invalid' },
    { qualificationRef: undefined }, { limits: undefined }])
    denied(() => captureServiceProfiles({ profile, claudeOAuthEnrollment: { ...claudeOAuthEnrollment, ...patch } as typeof claudeOAuthEnrollment }));
});
