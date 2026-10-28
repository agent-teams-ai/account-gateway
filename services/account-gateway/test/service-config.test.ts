import test from "node:test";
import assert from "node:assert/strict";
import {
  captureServiceBearers,
  captureServiceProfiles,
  glmProfile,
  kimiProfile,
  minimaxProfile,
  captureGrokOAuthEnrollmentConfig,
  ServiceError,
} from "../src/service-config.ts";

const serviceProfile = (requests: number) => ({
  profile: "openai-responses-apikey-v1",
  model: "gpt-5.4-mini",
  baseURL: "https://api.openai.com/v1",
  qualificationRef: "qualification-a",
  limits: {
    requests,
    concurrency: 1,
    requestBytes: 1_048_576,
    outputBytes: 1_048_576,
    tokens: 32_768,
  },
  providerTokenUpperBound: 100_000,
});
const denied = (body: () => unknown) => {
  assert.throws(body, (e) => e instanceof ServiceError && e.code === "config_denied");
};

void test("new keyed profiles accept only immutable provider tuples and GLM owner policy is not config-selectable", () => {
  const limits = {
    requests: 2,
    concurrency: 1,
    requestBytes: 4096,
    outputBytes: 8192,
    tokens: 1000,
  };
  for (const tuple of [kimiProfile, glmProfile, minimaxProfile]) {
    const selected = {
      ...tuple,
      qualificationRef: "source-provider",
      limits,
      providerTokenUpperBound: 1000,
    };
    assert.deepEqual(captureServiceProfiles({ profile: selected }), [selected]);
    denied(() => captureServiceProfiles({ profile: { ...selected, model: "unqualified-model" } }));
    denied(() =>
      captureServiceProfiles({ profile: { ...selected, baseURL: "https://provider.example" } }),
    );
    denied(() =>
      captureServiceProfiles({ profile: { ...selected, profile: "different-profile" } }),
    );
  }
});

void test("all keyed provider leaves coexist and duplicate or invented leaves deny", () => {
  const limits = {
    requests: 2,
    concurrency: 1,
    requestBytes: 4096,
    outputBytes: 8192,
    tokens: 1000,
  };
  const providerProfiles = [kimiProfile, glmProfile, minimaxProfile].map((tuple) => ({
    ...tuple,
    qualificationRef: "source-provider",
    limits,
    providerTokenUpperBound: 1000,
  }));
  const profile = serviceProfile(2);
  assert.equal(captureServiceProfiles({ profile, providerProfiles }).length, 4);
  denied(() =>
    captureServiceProfiles({
      profile,
      providerProfiles: [providerProfiles[0], providerProfiles[0]],
    }),
  );
  denied(() =>
    captureServiceProfiles({
      profile,
      providerProfiles: [{ ...providerProfiles[0], profile: "other-profile" }],
    }),
  );
});

// Red if raising the run budget needs a code change again: the operational knob is the service
// profile, the code keeps only the acceptance ceiling.
void test("service profile admits production budgets up to the code ceiling and denies above it", () => {
  const [prod] = captureServiceProfiles({ profile: serviceProfile(640) });
  assert.equal(prod.limits.requests, 640);
  const [ceiling] = captureServiceProfiles({ profile: serviceProfile(10_000) });
  assert.equal(ceiling.limits.requests, 10_000);
  denied(() => captureServiceProfiles({ profile: serviceProfile(10_001) }));
});

// Red if configuration intersects output across profiles instead of capturing
// the selected envelope, or grants borrow an unselected profile's authority.
void test("consumer output envelope uses only selected profiles and preserves all other grant bounds", () => {
  const profiles = [
    serviceProfile(640),
    {
      ...serviceProfile(640),
      profile: "other-profile",
      limits: { ...serviceProfile(640).limits, outputBytes: 8_388_608 },
    },
  ];
  const control = {
    role: "consumer-control" as const,
    token: "synthetic-consumer-control",
    consumerId: "fixture-consumer",
    profileIds: profiles.map((p) => p.profile),
    limits: { ...profiles[0].limits, outputBytes: 8_388_608 },
    maxRunMs: 21_600_000,
  };
  const capture = (value: unknown) => captureServiceBearers([value], control.consumerId, profiles);
  assert.deepEqual(capture(control), [control]);
  denied(() => capture({ ...control, profileIds: [profiles[0].profile] }));
  denied(() => capture({ ...control, profileIds: [...control.profileIds, "missing"] }));
  denied(() => capture({ ...control, limits: { ...control.limits, outputBytes: 8_388_609 } }));
  for (const field of ["requests", "concurrency", "requestBytes", "tokens"] as const) {
    denied(() =>
      capture({ ...control, limits: { ...control.limits, [field]: control.limits[field] + 1 } }),
    );
  }
  denied(() => capture({ ...control, role: "run-control", ownerRefs: ["fixture-owner"] }));
  denied(() =>
    capture({
      role: "management",
      token: control.token,
      consumerId: control.consumerId,
      ownerRefs: ["fixture-owner"],
      preparation: {
        accountRefs: [],
        subjectRef: "fixture-subject",
        policyRevision: 1,
        bindingRevision: 1,
        profileId: profiles[0].profile,
        limits: control.limits,
        maxRunMs: 60_000,
      },
    }),
  );
  assert.deepEqual(capture({ ...control, limits: profiles[0].limits, maxRunMs: 1 }), [
    { ...control, limits: profiles[0].limits, maxRunMs: 1 },
  ]);
});

// Red if the canonical configuration parser still rejects the native raw-SSE
// ceiling, or if widening total response bytes also widens unrelated limits.
void test("qualified Codex profile admits eight MiB raw SSE and rejects one byte above", () => {
  const limits = {
    requests: 1,
    concurrency: 1,
    requestBytes: 1_048_576,
    outputBytes: 1_048_576,
    tokens: 32_768,
  };
  const profile = {
    profile: "openai-responses-apikey-v1",
    model: "mimo-v2-pro",
    baseURL: "https://api.xiaomimimo.com/v1",
    qualificationRef: "synthetic-mimo",
    limits,
    providerTokenUpperBound: 32_768,
  };
  const oauthEnrollment = {
    enabled: true as const,
    profile: "openai-codex-oauth-responses-v1" as const,
    modelScope: ["gpt-5.6-sol"] as const,
    qualificationRef: "synthetic-codex",
    limits: { ...limits, outputBytes: 8_388_608 },
    providerTokenUpperBound: 32_768,
  };
  const captured = captureServiceProfiles({ profile, oauthEnrollment });
  assert.deepEqual(captured[1].limits, { ...limits, outputBytes: 8_388_608 });
  assert.deepEqual(captured[0].limits, limits);
  assert.throws(() =>
    captureServiceProfiles({
      profile,
      oauthEnrollment: {
        ...oauthEnrollment,
        limits: { ...oauthEnrollment.limits, outputBytes: 8_388_609 },
      },
    }),
  );
  assert.throws(() =>
    captureServiceProfiles({
      profile,
      oauthEnrollment: {
        ...oauthEnrollment,
        limits: { ...oauthEnrollment.limits, requestBytes: 1_048_577 },
      },
    }),
  );
});

// The independent opt-in must not borrow Codex qualification or accept caller endpoints.
void test("Claude enrollment captures only the fixed qualified tuple alongside Codex", () => {
  const profile = serviceProfile(4);
  const claudeOAuthEnrollment = {
    enabled: true as const,
    profile: "anthropic-claude-oauth-messages-v1" as const,
    modelScope: ["claude-sonnet-4-6"] as const,
    qualificationRef: "synthetic-claude",
    limits: profile.limits,
    providerTokenUpperBound: 65536,
  };
  const oauthEnrollment = {
    enabled: true as const,
    profile: "openai-codex-oauth-responses-v1" as const,
    modelScope: ["gpt-5.6-sol"] as const,
    qualificationRef: "synthetic-codex",
    limits: profile.limits,
    providerTokenUpperBound: 65536,
  };
  const profiles = captureServiceProfiles({ profile, oauthEnrollment, claudeOAuthEnrollment });
  assert.deepEqual(
    profiles.map((p) => [p.profile, p.model, p.qualificationRef]),
    [
      ["openai-responses-apikey-v1", "gpt-5.4-mini", "qualification-a"],
      ["openai-codex-oauth-responses-v1", "gpt-5.6-sol", "synthetic-codex"],
      ["anthropic-claude-oauth-messages-v1", "claude-sonnet-4-6", "synthetic-claude"],
    ],
  );
  for (const patch of [
    { profile: oauthEnrollment.profile },
    { modelScope: ["other"] },
    { baseURL: "https://fixture.invalid" },
    { qualificationRef: undefined },
    { limits: undefined },
  ]) {
    denied(() =>
      captureServiceProfiles({
        profile,
        claudeOAuthEnrollment: {
          ...claudeOAuthEnrollment,
          ...patch,
        } as typeof claudeOAuthEnrollment,
      }),
    );
  }
});

void test("Grok needs explicit deployment qualification and cannot bypass it through the key profile", () => {
  const limits = {
    requests: 2,
    concurrency: 1,
    requestBytes: 4096,
    outputBytes: 8192,
    tokens: 1000,
  };
  const grok = {
    enabled: true,
    profile: "grok-subscription-responses-oauth-v1",
    modelScope: ["grok-4.7"],
    qualificationRef: "source-provider",
    limits,
    providerTokenUpperBound: 1000,
    deploymentQualified: true,
    clientId: "qualified-client",
    authorizationOrigin: "https://auth.x.ai",
    redirectPolicy: "manual_loopback",
    redirectURI: "http://127.0.0.1:56121/callback",
  };
  assert.deepEqual(captureGrokOAuthEnrollmentConfig(grok), grok);
  denied(() => captureGrokOAuthEnrollmentConfig({ ...grok, deploymentQualified: false }));
  denied(() => captureGrokOAuthEnrollmentConfig({ ...grok, profile: "wrong-profile" }));
  denied(() =>
    captureServiceProfiles({
      profile: {
        profile: grok.profile,
        model: "grok-4.7",
        baseURL: "https://cli-chat-proxy.grok.com",
        qualificationRef: "source-provider",
        limits,
        providerTokenUpperBound: 1000,
      },
    }),
  );
});
